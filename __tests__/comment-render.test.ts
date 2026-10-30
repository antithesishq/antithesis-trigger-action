import * as fc from 'fast-check'
import {
  comment_marker,
  escape_cell,
  has_marker,
  MAX_COMMENT_CHARS,
  MAX_STATUS_DESCRIPTION_CHARS,
  render_comment,
  render_status_description,
  truncate,
  type CommentPhase,
  type CommentView
} from '../src/comment-render'
import type { PropertiesSnapshot } from '../src/run-state'
import type { Property } from '../src/snouty-client'

const phases: CommentPhase[] = [
  'launching',
  'running',
  'completed',
  'run_failed',
  'api_error',
  'timed_out',
  'aborted'
]

// Free text that the tests do not want to mistake for layout.
const prose_arb = (max: number): fc.Arbitrary<string> =>
  fc
    .string({ maxLength: max })
    .filter(s => !s.includes('<details') && !s.includes('</details'))

const property_arb: fc.Arbitrary<Property> = fc.record({
  id: fc.stringMatching(/^[0-9a-f]{1,8}$/),
  name: prose_arb(300),
  status: fc.constant('Failing'),
  group: fc.option(prose_arb(200), { nil: null }),
  counterexample_count: fc.nat({ max: 100_000 })
})

const snapshot_arb: fc.Arbitrary<PropertiesSnapshot> = fc
  .record({
    failing: fc.array(property_arb, { maxLength: 400 }),
    passing_count: fc.nat({ max: 100_000 }),
    undetermined_count: fc.nat({ max: 100_000 }),
    fetched_at: fc.nat()
  })
  .map(s => ({ ...s, failing_count: s.failing.length }))

const view_arb: fc.Arbitrary<CommentView> = fc.record({
  marker_key: fc.string({ minLength: 1, maxLength: 40 }),
  title: prose_arb(60).filter(s => s.trim() !== ''),
  phase: fc.constantFrom(...phases),
  run_id: fc.option(fc.stringMatching(/^[0-9a-f]{4,40}$/), {
    nil: undefined
  }),
  run_url: fc.option(fc.webUrl(), { nil: undefined }),
  commit_sha: fc.stringMatching(/^[0-9a-f]{7,40}$/),
  snapshot: fc.option(snapshot_arb, { nil: undefined }),
  updated_at: fc
    .date({
      min: new Date(0),
      max: new Date(4102444800000),
      noInvalidDate: true
    })
    .map(d => d.toISOString()),
  status_label: fc.option(
    fc.constantFrom('incomplete', 'cancelled', 'unknown'),
    {
      nil: undefined
    }
  ),
  reason: fc.option(prose_arb(500), { nil: undefined }),
  max_failures: fc.integer({ min: 1, max: 50 }),
  update_cadence: fc.option(fc.constant('about every 60s'), { nil: undefined }),
  waited_label: fc.option(fc.constant('2h'), { nil: undefined })
})

const base_view: CommentView = {
  marker_key: 'my-test',
  title: 'my-test',
  phase: 'running',
  run_id: 'abc-66-0',
  run_url: 'https://tenant.antithesis.com/run?run_id=abc-66-0',
  commit_sha: '1234567890abcdef',
  snapshot: {
    failing: [
      {
        id: '1',
        name: 'Node never loses acknowledged writes',
        status: 'Failing',
        group: 'durability',
        counterexample_count: 3
      },
      {
        id: '2',
        name: 'Leader election converges',
        status: 'Failing',
        group: null,
        counterexample_count: 1
      }
    ],
    passing_count: 12,
    failing_count: 2,
    undetermined_count: 3,
    fetched_at: 0
  },
  updated_at: '2026-10-29T21:30:00.000Z',
  max_failures: 25,
  update_cadence: 'about every 60s'
}

/** The failing-property rows of a rendered comment. */
function table_rows(body: string): string[] {
  return body.split('\n').filter(l => l.startsWith('| `'))
}

describe('marker', () => {
  it('round-trips arbitrary test names, including ones that could close the comment', () => {
    fc.assert(
      fc.property(view_arb, view => {
        const marker = comment_marker(view.marker_key)
        const body = render_comment(view)
        return (
          body.split('\n')[0] === marker &&
          has_marker(body, view.marker_key) &&
          // The marker itself never contains the comment terminator early.
          marker.indexOf('-->') === marker.length - 3
        )
      })
    )
  })

  it('does not match another test’s marker, nor an arbitrary body', () => {
    expect(has_marker(render_comment(base_view), 'other-test')).toBe(false)
    expect(has_marker('hello', 'my-test')).toBe(false)
    expect(has_marker(null, 'my-test')).toBe(false)
  })
})

describe('render_comment', () => {
  it('matches the running layout', () => {
    expect(render_comment(base_view)).toMatchSnapshot()
  })

  it.each(phases)('matches the %s layout', phase => {
    expect(
      render_comment({
        ...base_view,
        phase,
        status_label: phase === 'run_failed' ? 'incomplete' : undefined,
        reason:
          phase === 'run_failed'
            ? 'the environment failed to build'
            : phase === 'api_error'
              ? 'run not found: abc'
              : undefined,
        waited_label: '5h50m'
      })
    ).toMatchSnapshot()
  })

  it('omits the failing section when nothing fails', () => {
    fc.assert(
      fc.property(
        view_arb.map(v => ({
          ...v,
          snapshot: v.snapshot && {
            ...v.snapshot,
            failing: [],
            failing_count: 0
          }
        })),
        view => {
          const body = render_comment(view)
          return table_rows(body).length === 0 && !body.includes('<details')
        }
      )
    )
  })

  it('lists at most max_failures rows and says how many more there are', () => {
    fc.assert(
      fc.property(
        view_arb.filter(v => (v.snapshot?.failing_count ?? 0) > 0),
        view => {
          const body = render_comment(view)
          const snapshot = view.snapshot as PropertiesSnapshot
          const rows = table_rows(body).length
          const shown = Math.min(snapshot.failing_count, view.max_failures)
          // Rows may be dropped below `shown` only to fit the size cap.
          if (rows > shown) return false
          const overflow = snapshot.failing_count - rows
          return overflow > 0
            ? body.includes(`…and ${overflow} more`)
            : !body.includes('more —')
        }
      )
    )
  })

  it('never exceeds GitHub’s comment size, and never breaks a table cell', () => {
    fc.assert(
      fc.property(view_arb, view => {
        const body = render_comment(view)
        // Three cells: an unescaped pipe would add a fourth.
        const cells_ok = table_rows(body).every(
          line => line.split(/(?<!\\)\|/).length === 5
        )
        return body.length <= MAX_COMMENT_CHARS && cells_ok
      })
    )
  })

  it('is deterministic', () => {
    fc.assert(
      fc.property(
        view_arb,
        view => render_comment(view) === render_comment(view)
      )
    )
  })

  it('always shows the counts and the run link when there is one', () => {
    fc.assert(
      fc.property(view_arb, view => {
        const body = render_comment(view)
        const counts_ok =
          view.snapshot === undefined ||
          (body.includes(`${view.snapshot.passing_count} passing`) &&
            body.includes(`${view.snapshot.failing_count} failing`))
        const link_ok =
          view.run_url === undefined || body.includes(`](${view.run_url})`)
        return counts_ok && link_ok
      })
    )
  })
})

describe('render_status_description', () => {
  it('fits GitHub’s 140-character limit for every view', () => {
    fc.assert(
      fc.property(view_arb, view => {
        const text = render_status_description(view)
        return (
          text.length <= MAX_STATUS_DESCRIPTION_CHARS && !text.includes('\n')
        )
      })
    )
  })

  it('summarises the counts', () => {
    expect(render_status_description(base_view)).toBe(
      'Antithesis is running: 12 passing, 2 failing, 3 undetermined.'
    )
    expect(
      render_status_description({ ...base_view, phase: 'completed' })
    ).toBe('Antithesis run completed: 12/17 properties passing (2 failing).')
    expect(
      render_status_description({
        ...base_view,
        phase: 'run_failed',
        status_label: 'incomplete',
        reason: 'boom'
      })
    ).toBe('Antithesis run ended as incomplete: boom')
  })
})

describe('cell helpers', () => {
  it('truncate keeps at most max characters and leaves short text alone', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 200 }), (s, max) => {
        const out = truncate(s, max)
        return out.length <= max && (s.length > max || out === s)
      })
    )
  })

  it('escape_cell removes newlines and escapes pipes', () => {
    fc.assert(
      fc.property(fc.string(), s => {
        const out = escape_cell(s)
        return !/\r|\n/.test(out) && !out.replace(/\\\|/g, '').includes('|')
      })
    )
  })
})
