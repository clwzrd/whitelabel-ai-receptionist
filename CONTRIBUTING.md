# Contributing

Bug reports, fixes and improvements are welcome.

## Before you open a pull request

1. Open an issue first for anything larger than a small fix, so the approach
   can be agreed before you spend time on it.
2. Fork the repository and work on a branch.
3. Run the checks:

```bash
npm install
npm test        # the whole suite; no phone, no keys, no database needed
npm run check   # types
```

   A change to how the assistant talks is easier to judge with a real model:
   `npm run try -- "..."` runs a conversation in text.

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
