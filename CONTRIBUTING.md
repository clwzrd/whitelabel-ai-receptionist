# Contributing

Bug reports, fixes and improvements are welcome.

## Before you open a pull request

1. Open an issue first for anything larger than a small fix, so the approach
   can be agreed before you spend time on it.
2. Fork the repository and work on a branch.
3. Run the checks:

```bash
git clone https://github.com/clwzrd/whitelabel-crm
cd whitelabel-crm && npm ci
npm test          # includes the receptionist's tests
npx astro check
```

   This repository mirrors the receptionist's code from `whitelabel-crm`, where
   it runs and is tested. Send the pull request there; the same paths exist in
   both.

4. Keep the change focused: one problem per pull request, with a description
   of what was wrong and how you checked the fix.

## Ground rules

- Never commit secrets, real customer data, or real phone numbers and e-mail
  addresses. Tests use `example.com`, `.test` and invented numbers.
- Nothing in the code may name a company. Operator branding comes from
  configuration.

## Licence

By contributing you agree that your contribution is licensed under the
GNU Affero General Public License v3.0, the licence of this project.

## Security

Do not open a public issue for a vulnerability. See `SECURITY.md`.
