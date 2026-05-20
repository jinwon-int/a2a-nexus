# GitHub 403 Troubleshooting Guide for Parent-Round Closeout

> **Contract:** `contracts/a2a/parent-round-closeout-go-nogo-matrix.md`
> **Section:** [GitHub 403 rollback/no-op behavior](../../../contracts/a2a/parent-round-closeout-go-nogo-matrix.md#github-403-rollbackno-op-behavior)

This guide covers diagnosis and resolution of HTTP 403 (Forbidden) errors encountered during
parent-round closeout operations on GitHub.

## Common causes

| Cause | Typical error message | Detection method |
|---|---|---|
| Token lacks `issue:write` scope | `"Resource not accessible by integration"` | Check token scopes via GitHub API |
| Token lacks `issues:write` scope | `"Resource not accessible by integration"` | Check token scopes via GitHub API |
| Repository is archived | `"This repository is archived. No changes are allowed."` | Check repo metadata: `gh repo view --json isArchived` |
| Repository is read-only for the token | `"You must have push access to this repository"` | Check token permissions for this repo |
| Organization-level restrictions | `"Organization has disabled this action"` | Check org settings for issue comments/closing |
| Rate limiting | `"You have exceeded a secondary rate limit"` | Check `X-RateLimit-Remaining` header |
| Token expired or revoked | `"Bad credentials"` (often 401, but may surface as 403) | Re-authenticate `gh auth status` |

## Diagnostic commands

```bash
# Verify token authentication
gh auth status

# Check if the parent issue can be commented on
gh api /repos/:owner/:repo/issues/:number \
  --jq '.state, .locked, .comments'

# Check if we can post a comment (dry-run by checking permissions)
gh api /repos/:owner/:repo/issues/:number/comments \
  --method POST \
  --field body="test-comment-permission-check" \
  2>&1 || echo "403 detected"

# Check repository archival status
gh repo view :owner/:repo --json isArchived

# Check token scopes
gh api /user --jq '.login'
gh api /user/repository_invitations --jq '. | length'
```

## Resolution steps

### 1. Token scope issue

Ensure the GitHub token has at minimum:

- `issues:write` — required for posting issue comments and closing issues
- `contents:read` — required for reading repository content

Verify:

```bash
# Decode the token to check scopes (token is not shown)
gh auth status -v
```

If scopes are insufficient:

1. Regenerate the token with the required scopes in GitHub Settings → Developer settings →
   Personal access tokens.
2. Update the `GH_TOKEN` environment variable or the credential store.
3. Re-authenticate: `gh auth login` or update `~/.config/gh/hosts.yml`.

### 2. Archived repository

If the repository is archived:

```bash
gh repo view :owner/:repo --json isArchived
# If isArchived is true, the repo must be unarchived first:
# - Go to repo Settings → Danger Zone → Unarchive this repository
# - Or use: gh api /repos/:owner/:repo --method PATCH --field archived=false
#   (requires admin access)
```

After unarchiving, retry the closeout operation.

### 3. Organization-level restrictions

Check:

```bash
gh api /orgs/:org/settings -q '.members_can_create_issues'
```

If organization policy blocks commenting or closing issues:

1. Open an issue with the organization admin requesting the required permissions.
2. Use a different token that belongs to an admin or has bypass privileges.

### 4. Rate limiting

```bash
# Check rate limit status
gh api /rate_limit --jq '.rate'

# If remaining is 0, wait until the reset timestamp:
gh api /rate_limit --jq '.rate.reset | strftime("%Y-%m-%dT%H:%M:%SZ")'
```

Exponential backoff:

```bash
# If you hit rate limits, wait before retrying
sleep 60
# After waiting, retry the operation
```

### 5. Expired or revoked token

```bash
gh auth status
# If status shows "not logged in" or token error:
gh auth login
# Follow the interactive flow to obtain a new token
```

## Prevention

1. **Preflight permission check**: Before initiating closeout, run the GitHub permission check
   gate (G7) which probes the token's ability to comment and close issues.
2. **Read-only mode**: Run the closeout evaluator in `--dry-run` mode first to catch permission
   issues before attempting writes.
3. **Token rotation**: Ensure the closeout token is rotated regularly and has a long enough
   expiry to cover the expected closeout window.
4. **Repository lock check**: Include repository archival status in the preflight checklist.

## Automation behavior

- The closeout evaluator does **not** automatically retry after a 403.
- A 403 causes the G7 gate to transition to `BLOCKED`, and the overall decision to `BLOCKED`.
- The operator must manually resolve the 403 and then re-run the evaluator.
- A 403 rollback is always metadata-only: no existing evidence is deleted or overwritten.

## References

- [GitHub REST API: Issues](https://docs.github.com/en/rest/issues/issues)
- [GitHub REST API: Issue comments](https://docs.github.com/en/rest/issues/comments)
- [Rate limiting documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [OAuth scopes for GitHub apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
