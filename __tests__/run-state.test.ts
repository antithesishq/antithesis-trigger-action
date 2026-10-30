import * as fc from 'fast-check'
import { is_terminal, snapshot_from_lists } from '../src/run-state'
import type { Property } from '../src/snouty-client'

const property_arb: fc.Arbitrary<Property> = fc.record({
  id: fc.stringMatching(/^[0-9a-f]{1,8}$/),
  name: fc.string({ maxLength: 20 }),
  status: fc.constantFrom('Failing', 'Passing', 'Undetermined'),
  group: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
  counterexample_count: fc.nat({ max: 5000 })
})

describe('is_terminal', () => {
  it.each(['completed', 'cancelled', 'incomplete', 'unknown'])(
    '%s is terminal',
    s => {
      expect(is_terminal(s)).toBe(true)
    }
  )
  it.each(['starting', 'in_progress', undefined, 'paused'])(
    '%s is not terminal',
    s => {
      expect(is_terminal(s)).toBe(false)
    }
  )
})

describe('snapshot_from_lists', () => {
  it('counts each list and keeps every failing property, sorted by group then name', () => {
    fc.assert(
      fc.property(
        fc.array(property_arb),
        fc.array(property_arb),
        fc.array(property_arb),
        fc.nat(),
        (failing, passing, undetermined, at) => {
          const snapshot = snapshot_from_lists(
            failing,
            passing,
            undetermined,
            at
          )
          expect(snapshot.failing_count).toBe(failing.length)
          expect(snapshot.passing_count).toBe(passing.length)
          expect(snapshot.undetermined_count).toBe(undetermined.length)
          expect(snapshot.fetched_at).toBe(at)
          // Same multiset of properties, whatever the order.
          const key = (p: Property): string => JSON.stringify(p)
          expect([...snapshot.failing].map(key).sort()).toEqual(
            [...failing].map(key).sort()
          )
          for (let i = 1; i < snapshot.failing.length; i++) {
            const a = snapshot.failing[i - 1]
            const b = snapshot.failing[i]
            const ga = a.group ?? ''
            const gb = b.group ?? ''
            const in_order = ga < gb || (ga === gb && a.name <= b.name)
            expect(in_order).toBe(true)
          }
        }
      )
    )
  })

  it('is deterministic regardless of input order', () => {
    fc.assert(
      fc.property(fc.array(property_arb), fc.nat(), (failing, seed) => {
        const shuffled = [...failing].sort(() => (seed % 3) - 1)
        expect(snapshot_from_lists(shuffled, [], [], 0).failing).toEqual(
          snapshot_from_lists(failing, [], [], 0).failing
        )
      })
    )
  })
})
