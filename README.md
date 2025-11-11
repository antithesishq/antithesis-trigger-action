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
1. Add your Antithesis `username` and `password` to your GitHub repository's
   secrets and variables.
> [!TIP]
> Go to `https://github.com/<owner>/<repo>/settings/secrets/actions`,
> then add two new repository secrets named `ANTITHESIS_USERNAME` and 
> `ANTITHESIS_PASSWORD` whose values are your Antithesis username and 
> password respectively.

2. [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens)
   to enable Antithesis to post back results to GitHub. 
> [!NOTE] 
> We recommend that you configure the token as follows:
> - Set repository access to **Only select repositories** > Select repositories > (the repository you're testing)
> - Only grant the following permissions:
> | Permission | Access type |
> | --- | --- |
> | Metadata | Read-only |
> | Commit statuses | Read and write |
> | Contents | Read-only |
> | Pull requests | Read-only |
> For example:
> ![github_pat_token_permissions](https://github.com/antithesishq/antithesis-trigger-action/assets/3439582/935c5c58-e158-4558-a455-9a5f99d48c8b)

3. Add your token to the repository secrets as you did in step 1, and give it
   the name `GH_PAT`.

4. Call the
   [Antithesis Trigger Action](https://github.com/antithesishq/antithesis-trigger-action)
   in your workflow file by adding a step in the following format:

```yml
- name: Run Antithesis Tests
  uses: antithesishq/antithesis-trigger-action@v0.X
  with:
    # Inputs which let your workflow call Antithesis:
    tenant: my-tenant-name
    username: ${{ secrets.ANTITHESIS_USERNAME }}
    password: ${{ secrets.ANTITHESIS_PASSWORD }}
    notebook_name: my-test-notebook-name

    # Inputs which tell Antithesis what to test:
    config_image: myconfigcontainer@digest
    images: mycontainer1@digest;mycontainer2:tag

    # Inputs which tell Antithesis how to report back:
    github_token: ${{ secrets.GH_PAT }}
    email_recipients: email1@provider.com;email2@provider.com

    # Inputs which specify metadata about what you're running:
    description: my-desc
    test_name: my-test-name

    # Other parameters go here:
    additional_parameters: |-
      parameter1_name=parameter1_value
      parameter2_name=parameter2_value
```

> [!TIP]
> If any of these are incorrect, your run won't start:
> - `tenant`: your tenant's name (e.g. If your subdomain is
> $TENANT_NAME.antithesis.com, your tenant name is `$TENANT_NAME`)
> - `username` and `password`: your Antithesis credentials, as stored in your secrets
> - `notebook_name`: the name of your test that will be run (provided by
> Antithesis)
> 
> If any of these are incorrect, Antithesis may not test what you want:
> - `config_image`: The image version that Antithesis will pull from the
>   container registry for the config image. This should be a single image version
>   formatted in the same way as those in the antithesis.images parameter.
> - ``images``: The image versions that Antithesis will use to build your test
>   environment. The images are specified as an optional registry, a container
>   name and either a digest (which is recommended) or a tag. A ‘;’ delimited
>   list. Each entry is in this format: `[REGISTRY/]NAME[:TAG|@DIGEST]`.
> 
> If any of these are incorrect, you may not hear about results:
> - `email_recipients`: A semi-colon delimited list of the email addresses for
>   the recipients who will be emailed links to the triage report produced by this
>   test run. If this parameter is not specified, emails will be sent to the
>   default users set up for the test.
> 
> These are used to show you information about your runs:
> - `description`: A string description of your test run. The description will
>   be in the headers of the generated report and of any emails triggered by the
>   test run.
> - `test_name`: An optional name for the test you are running. When specified,
>   the Git commit's status context will be
>   `continuous-testing/antithesis (test_name)`. Otherwise, the default context is
>   `continuous-testing/antithesis`. This enables users to run more than one
>   Antithesis test per commit.
> 
> If Customer Experience sets up notebook-specific parameters for you, specify them 
> in `additional_parameters` as a newline-seperated list.


## FAQ
### How can I run multiple tests on the same commit using this GitHub Action?
To run multiple tests from the same commit using this GitHub Action, you can set
a unique `test_name` parameter when calling the action. This will create a
unique Git commit status context for every unique `test_name` specified. The
example below shows what this will look like if 2 tests were ran for a commit
one called _first test_ and the other called _second test_.

![multiple-tests-per-commit-example](https://github.com/user-attachments/assets/dfde256c-74b1-4204-b1e7-4ab290a58bfe)
