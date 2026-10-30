# Antithesis trigger GitHub Action

[![GitHub Super-Linter](https://github.com/antithesishq/antithesis-trigger-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/antithesishq/antithesis-trigger-action/actions/workflows//ci.yml/badge.svg)
[![Check dist/](https://github.com/antithesishq/antithesis-trigger-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/antithesishq/antithesis-trigger-action/actions/workflows/check-dist.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

This action runs an [Antithesis](https://www.antithesis.com/) test run as a step
in a GitHub Action workflow job.

## What is Antithesis?

Antithesis is a **continuous reliability platform** that **autonomously
searches** for problems in your software within a **simulated environment**.
Every problem we find can be **perfectly reproduced**, allowing for **efficient
debugging** of even the most complex problems.

## Usage

This action takes the following inputs to configure its behavior. You can see an
example usage here in our demo project
[glitch-grid](https://github.com/antithesishq/glitch-grid/blob/main/.github/workflows/ci_integration_go.yml).

### Instructions

1. Add your Antithesis credentials to your GitHub repository secrets. The action
   supports two authentication methods — use **one** of them:
   - **API key (recommended)**: store your Antithesis API key as a repository
     secret named `ANTITHESIS_API_KEY`. The action sends it as
     `Authorization: Bearer <api_key>`. Contact `support@antithesis.com` or your
     forward-deployed engineer to obtain a key.
   - **Basic auth (legacy)**: store your Antithesis username and password as
     repository secrets named `ANTITHESIS_USERNAME` and `ANTITHESIS_PASSWORD`.

   Navigate to your repository action secrets settings found
   [here](https://github.com/<org_name>/<repo_name>/settings/secrets/actions) to
   add the secret(s). If both an API key and username/password are provided, the
   API key takes precedence.

2. Create a limited scope PAT token to enable Antithesis to post back results to
   GitHub. (Only needed for the default `fire-and-forget` mode: with
   `mode: comment` the workflow's own `${{ github.token }}` is enough, see
   [Live pull request comments](#live-pull-request-comments-mode-comment).)
   Navigate to your fine-grained access token settings found
   [here](https://github.com/settings/tokens?type=beta) and create a limited
   scope fine-grained access token with minimal permissions. It is recommended
   to limit the token to the repository running the workflow and to only grant
   the token permission to read the repository metadata and to read/write the
   commit status. For example:

![github_pat_token_permissions](https://github.com/antithesishq/antithesis-trigger-action/assets/3439582/935c5c58-e158-4558-a455-9a5f99d48c8b)

3. Add your token to the repository secrets as you did in step one, and give it
   the name `GH_PAT`.

4. Call the
   [Antithesis Trigger Action](https://github.com/antithesishq/antithesis-trigger-action)
   in your workflow file. Using an API key:

```yml
- name: Run Antithesis Tests
  uses: antithesishq/antithesis-trigger-action@v0.13
  with:
    notebook_name: my-test-notebook-name
    tenant: my-tenant-name
    api_key: ${{ secrets.ANTITHESIS_API_KEY }}
    github_token: ${{ secrets.GH_PAT }}
    config_image: myconfigcontainer@digest
    images: mycontainer1@digest;mycontainer2:tag
    description: my-desc
    email_recipients: email1@provider.com;email2@provider.com
    test_name: the-test-name
    additional_parameters: |-
      parameter1_name=parameter1_value
      parameter2_name=parameter2_value
```

Or using basic auth (legacy):

```yml
- name: Run Antithesis Tests
  uses: antithesishq/antithesis-trigger-action@v0.13
  with:
    notebook_name: my-test-notebook-name
    tenant: my-tenant-name
    username: ${{ secrets.ANTITHESIS_USERNAME }}
    password: ${{ secrets.ANTITHESIS_PASSWORD }}
    github_token: ${{ secrets.GH_PAT }}
    config_image: myconfigcontainer@digest
    images: mycontainer1@digest;mycontainer2:tag
    description: my-desc
    email_recipients: email1@provider.com;email2@provider.com
    test_name: the-test-name
```

### Inputs

- **notebook_name** : the name of your test that will be run (provided by
  Antithesis)
- **tenant** : your tenant's name (e.g. If your subdomain is
  $TENANT_NAME.antithesis.com, your tenant name is `$TENANT_NAME`)
- **api_key** : An Antithesis API key. When provided, the `username`/`password`
  inputs are ignored. When neither is provided, the action authenticates with
  the workflow's GitHub Actions OIDC token: grant the job
  `permissions: id-token: write` and ask Antithesis support to trust your
  repository.
- **username** / **password** : Your Antithesis username and password (legacy).
  They can launch a run but cannot read its results, so they do not work with
  `mode: comment`.
- **config_image** : The image version that Antithesis will pull from the
  container registry for the config image. This should be a single image version
  formatted in the same way as those in the antithesis.images parameter.
- **images** : The image versions that Antithesis will use to build your test
  environment. The images are specified as an optional registry, a container
  name and either a digest (which is recommended) or a tag. A ‘;’ delimited
  list. Each entry is in this format: `[REGISTRY/]NAME[:TAG|@DIGEST]`.
- **description** : A string description of your test run. The description will
  be in the headers of the generated report and of any emails triggered by the
  test run.
- **email_recipients** : A semi-colon delimited list of the email addresses for
  the recipients who will be emailed links to the triage report produced by this
  test run. If this parameter is not specified, emails will be sent to the
  default users set up for the test.
- **additional_parameters** : A newline-seperated list of additional parameters
  to be sent to the test run.
- **test_name**: An optional name for the test you are running. When specified,
  the Git commit's status context will be
  `continuous-testing/antithesis (test_name)`. Otherwise, the default context is
  `continuous-testing/antithesis`. This enables users to run more than one
  Antithesis test per commit. With `mode: comment` it also names the pull
  request comment, so each test gets its own.
- **mode** : `fire-and-forget` (default) or `comment`. See
  [Live pull request comments](#live-pull-request-comments-mode-comment).
- **poll_interval** (`30s`), **update_interval** (`60s`), **wait_timeout**
  (`5h50m`), **comment_max_failures** (`25`) : tuning for `mode: comment`,
  described below.
- **snouty_version** / **snouty_path** : the action talks to Antithesis through
  the [snouty](https://github.com/antithesishq/snouty) CLI, which it downloads
  from GitHub releases at the pinned version. On a runner without access to
  github.com releases, preinstall snouty and pass its path instead.

### Outputs

- **result** : `Success`, `Failed`, or `Skipped` (an `issue_comment` event that
  was not an `/antithesis` command).
- **run_id** / **run_url** : the Antithesis run id and its single run view.
- **status**, **passing**, **failing**, **undetermined** : with `mode: comment`,
  how the wait ended (`completed`, `run_failed`, `api_error`, `timed_out`,
  `aborted`) and the final property counts.

## Live pull request comments (`mode: comment`)

By default the action launches the run, posts a pending commit status that links
to the run, and exits; Antithesis finishes the status when the run ends. With
`mode: comment` the action instead stays in the job until the run is final and
keeps **one comment on the pull request** up to date as results stream in: the
run link, the passing/failing/undetermined counts, and a table of the failing
properties. When the run finishes, the comment and the commit status show the
final result and link to the run in Antithesis.

Requirements:

- a pull request: a `pull_request` or `pull_request_target` event, or an
  [`/antithesis` comment](#running-on-demand-with-antithesis);
- an `api_key` or GitHub Actions OIDC (username/password can only launch);
- a `github_token` that can write pull request comments and commit statuses. The
  workflow's own token is enough; no PAT is needed, because the action posts the
  final status itself.

```yml
on:
  pull_request:

jobs:
  antithesis:
    runs-on: ubuntu-latest
    timeout-minutes: 360
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    steps:
      - name: Run Antithesis Tests
        uses: antithesishq/antithesis-trigger-action@v0.13
        with:
          notebook_name: my-test-notebook-name
          tenant: my-tenant-name
          api_key: ${{ secrets.ANTITHESIS_API_KEY }}
          github_token: ${{ github.token }}
          mode: comment
          test_name: the-test-name
```

What the job result means in this mode:

- **Failing properties never fail the job.** They are reported in the comment
  and in the commit status description; the status itself is `success` when the
  run completed.
- The job fails only when Antithesis could not run the test: the run ended
  `incomplete` or `cancelled` (for example the environment failed to build or
  setup never completed), the launch returned no run id, or the results could
  not be read.
- If the run is still going when `wait_timeout` elapses (default `5h50m`, just
  under GitHub's six-hour job limit), the action leaves the comment at "still
  running", leaves the status pending, and exits successfully. Set `0` to wait
  until the job's own `timeout-minutes` instead.

Tuning:

- **poll_interval** : how often the run status is checked (minimum 15s).
- **update_interval** : the shortest time between two edits of the comment.
  Property events arrive through a live stream, so a new failure usually shows
  within this interval.
- **comment_max_failures** : how many failing properties the table lists before
  summarising the rest.

### Running on demand with `/antithesis`

Add a second workflow that listens for pull request comments. A comment whose
first line is `/antithesis` launches the run in comment mode; the action reacts
with :eyes: and then updates the pull request as above. Gate the workflow on who
may comment: anyone who can comment can otherwise start a run.

```yml
on:
  issue_comment:
    types: [created]

jobs:
  antithesis:
    if: >-
      github.event.issue.pull_request && startsWith(github.event.comment.body,
      '/antithesis') && contains(fromJSON('["OWNER", "MEMBER",
      "COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    timeout-minutes: 360
    permissions:
      contents: read
      pull-requests: write
      statuses: write
    steps:
      - name: Run Antithesis Tests
        uses: antithesishq/antithesis-trigger-action@v0.13
        with:
          notebook_name: my-test-notebook-name
          tenant: my-tenant-name
          api_key: ${{ secrets.ANTITHESIS_API_KEY }}
          github_token: ${{ github.token }}
```

Comments on a pull request that do not start with `/antithesis` make the action
exit with `result: Skipped` and no launch.

### Known limitations

- In the default `fire-and-forget` mode the final commit status is posted by
  Antithesis and links to the triage report; only the action's own pending
  status links to the single run view.
- On a pull request from a fork, `${{ github.token }}` is read-only: the run is
  launched, but the comment and status writes fail with a warning. Use
  `pull_request_target` if you need comments on fork pull requests.
- `username`/`password` cannot read results, so `mode: comment` falls back to
  `fire-and-forget` with them.
- If the job is cancelled or times out in comment mode, the commit status stays
  pending; the comment says where to look.
- Runs on tenants that do not support the property stream fall back to polling
  at `poll_interval`.

### FAQs

#### How can I run multiple tests on the same commit using this GitHub Action?

To run multiple tests from the same commit using this GitHub Action, you can set
a unique `test_name` parameter when calling the action. This will create a
unique Git commit status context for every unique `test_name` specified. The
example below shows what this will look like if 2 tests were ran for a commit
one called _first test_ and the other called _second test_.

![multiple-tests-per-commit-example](https://github.com/user-attachments/assets/dfde256c-74b1-4204-b1e7-4ab290a58bfe)
