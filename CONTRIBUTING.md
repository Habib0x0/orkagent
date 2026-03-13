# Contributing to orkagent

Thanks for your interest in contributing to orkagent.

## Getting Started

```bash
git clone https://github.com/Habib0x0/orkagent.git
cd orkagent
npm install
npm run build
npm run test
```

## Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Add or update tests as needed
4. Run `npm run test` and make sure everything passes
5. Submit a PR with a clear description of what you changed and why

## Commit Messages

Use conventional commits:

```
feat(scope): add new feature
fix(scope): fix a bug
docs(scope): update documentation
test(scope): add or update tests
refactor(scope): code changes that don't fix bugs or add features
```

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Node version, orkagent version)

## Code Style

- TypeScript strict mode
- No `any` unless genuinely needed
- `const` by default, `let` when mutation is needed
- Keep functions focused and small

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
