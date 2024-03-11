# Antithesis trigger GitHub Action

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

This action runs an [Antithesis](https://www.antithesis.com/) test run as a step in a GitHub Action workflow job.

## What is Antithesis?

Antithesis is a **continuous reliability platform** that **autonomously searches** for problems in your software within a **simulated environment**. Every problem we find can be **perfectly reproduced**, allowing for **efficient debugging** of even the most complex problems.

## Usage

This action takes the following inputs to configure its behavior. You can see an example usage here in our demo project [glitch-grid](https://github.com/antithesishq/glitch-grid/blob/main/.github/workflows/ci_integration_go.yml).

### Instructions

1. Add your Antithesis ``username`` and ``password`` to your GitHub repository secrets and variables. Navigate to your repository action secrets settings found [here](https://github.com/<org_name>/<repo_name>/settings/secrets/actions). Add a new repository secret, and give it the name ``ANTITHESIS_USER_NAME`` to store your Antithesis username. Add another secret, and give it the name ``ANTITHESIS_PASSWORD`` to store your Antithesis password.

2. Create a limited scope PAT token to enable Antithesis to post back results to GitHub. Navigate to your fine-grained access token settings found [here](https://github.com/settings/tokens?type=beta) and create a limited scope fine-grained access token with minimal permissions. It is recommended to limit the token to the repository running the workflow and to only grant the token permission to read the repository metadata and to read/write the commit status. For example:

![github_pat_token_permissions](https://github.com/antithesishq/antithesis-trigger-action/assets/3439582/935c5c58-e158-4558-a455-9a5f99d48c8b)

3. Add your token to the repository secrets as you did in step one, and give it the name ``GH_PAT``.

4. Call the [Antithesis Trigger Action](https://github.com/antithesishq/antithesis-trigger-action) in your workflow file by adding the following code:

```yml
    - name: Run Antithesis Tests
      uses: antithesishq/antithesis-trigger-action@v0.2
      with:
        notebook_name: my-test-notebook-name
        tenant: my-subdomain-name
        username: ${{ secrets.ANTITHESIS_USERNAME }}
        password: ${{ secrets.ANTITHESIS_PASSWORD }}
        github_token: ${{ secrets.GH_PAT }}
        images: mycontainer1@digest,mycontainer2:tag
```

### Inputs

- **my-test-notebook-name** : the name of your test that will be run (provided by Antithesis)
- **my-subdomain-name** : the subdomain for your tenant (e.g. `$TENANT_NAME.antithesis.com`)
- **images** : the list of containers to test, this is a comma seperated list of container images specified in this format `NAME[:TAG|@DIGEST]`
