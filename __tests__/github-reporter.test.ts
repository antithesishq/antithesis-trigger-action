import { comment_marker } from '../src/comment-render'
import {
  GithubReporter,
  NullReporter,
  octokit_api,
  type CommitState,
  type GithubApi
} from '../src/github-reporter'

function fake_api(
  existing: Array<{ id: number; body: string }> = []
): jest.Mocked<GithubApi> {
  return {
    list_comments: jest.fn<Promise<typeof existing>, [number]>(
      async () => existing
    ),
    create_comment: jest.fn<Promise<number>, [number, string]>(async () => 500),
    update_comment: jest.fn<Promise<void>, [number, string]>(
      async () => undefined
    ),
    create_commit_status: jest.fn<
      Promise<void>,
      [string, CommitState, string, string, string?]
    >(async () => undefined),
    react_to_comment: jest.fn<Promise<void>, [number, 'eyes' | 'rocket']>(
      async () => undefined
    )
  }
}

describe('GithubReporter.upsert_comment', () => {
  it('creates a comment when none carries our marker, then updates it', async () => {
    const api = fake_api([
      { id: 1, body: 'unrelated' },
      { id: 2, body: `${comment_marker('other')}\nhi` }
    ])
    const warn = jest.fn()
    const reporter = new GithubReporter(
      api,
      { sha: 's', pr_number: 9 },
      'mine',
      'ctx',
      warn
    )
    expect(await reporter.upsert_comment('body 1')).toBe(true)
    expect(api.create_comment).toHaveBeenCalledWith(9, 'body 1')
    expect(await reporter.upsert_comment('body 2')).toBe(true)
    expect(api.update_comment).toHaveBeenCalledWith(500, 'body 2')
    expect(api.list_comments).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reuses the newest existing comment with our marker', async () => {
    const api = fake_api([
      { id: 10, body: `${comment_marker('mine')}\nold` },
      { id: 11, body: `${comment_marker('mine')}\nnewer` }
    ])
    const reporter = new GithubReporter(
      api,
      { sha: 's', pr_number: 9 },
      'mine',
      'ctx',
      jest.fn()
    )
    await reporter.upsert_comment('body')
    expect(api.update_comment).toHaveBeenCalledWith(11, 'body')
    expect(api.create_comment).not.toHaveBeenCalled()
  })

  it('does nothing without a pull request', async () => {
    const api = fake_api()
    const reporter = new GithubReporter(
      api,
      { sha: 's' },
      'mine',
      'ctx',
      jest.fn()
    )
    expect(await reporter.upsert_comment('body')).toBe(false)
    expect(api.list_comments).not.toHaveBeenCalled()
  })

  it('swallows GitHub failures as warnings', async () => {
    const api = fake_api()
    api.list_comments.mockRejectedValue(
      new Error('403 Resource not accessible')
    )
    api.create_commit_status.mockRejectedValue(new Error('500'))
    api.react_to_comment.mockRejectedValue(new Error('nope'))
    const warn = jest.fn()
    const reporter = new GithubReporter(
      api,
      { sha: 's', pr_number: 9 },
      'mine',
      'ctx',
      warn
    )
    expect(await reporter.upsert_comment('body')).toBe(false)
    expect(await reporter.set_commit_status('pending', 'd', 'https://x')).toBe(
      false
    )
    expect(await reporter.react(1, 'eyes')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('403 Resource not accessible')
    )
  })

  it('posts commit statuses with the context and link', async () => {
    const api = fake_api()
    const reporter = new GithubReporter(
      api,
      { sha: 'sha1', pr_number: 9 },
      'mine',
      'continuous-testing/antithesis (t)',
      jest.fn()
    )
    expect(
      await reporter.set_commit_status('success', 'done', 'https://run')
    ).toBe(true)
    expect(api.create_commit_status).toHaveBeenCalledWith(
      'sha1',
      'success',
      'done',
      'continuous-testing/antithesis (t)',
      'https://run'
    )
  })
})

describe('NullReporter', () => {
  it('reports false for everything', async () => {
    const reporter = new NullReporter()
    expect(await reporter.upsert_comment()).toBe(false)
    expect(await reporter.set_commit_status()).toBe(false)
    expect(await reporter.react()).toBe(false)
  })
})

describe('octokit_api', () => {
  it('maps onto the octokit REST calls', async () => {
    const octokit = {
      paginate: jest.fn(async () => [{ id: 1, body: 'x' }]),
      rest: {
        issues: {
          listComments: jest.fn(),
          createComment: jest.fn(async () => ({ data: { id: 77 } })),
          updateComment: jest.fn(async () => ({}))
        },
        repos: { createCommitStatus: jest.fn(async () => ({})) },
        reactions: { createForIssueComment: jest.fn(async () => ({})) }
      }
    }
    const api = octokit_api(octokit as never, 'o', 'r')
    expect(await api.list_comments(3)).toEqual([{ id: 1, body: 'x' }])
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.issues.listComments,
      {
        owner: 'o',
        repo: 'r',
        issue_number: 3,
        per_page: 100
      }
    )
    expect(await api.create_comment(3, 'b')).toBe(77)
    await api.update_comment(77, 'c')
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 77,
      body: 'c'
    })
    await api.create_commit_status('s', 'pending', 'd', 'ctx', 'https://u')
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      sha: 's',
      state: 'pending',
      description: 'd',
      context: 'ctx',
      target_url: 'https://u'
    })
    await api.react_to_comment(5, 'eyes')
    expect(octokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      comment_id: 5,
      content: 'eyes'
    })
  })
})
