# Contributing

Thanks for taking the time to help. The project is small and the rules are
simple, so that everybody can follow them.

## The rules of the project

- **Never use a long dash.** Write `-` and not `—`, `–`, `‒` or `―`. It
  applies to the sources, the documentation, the notes of the vault and the
  answers of the bot. The formatter does not change them, the tests check
  them.
- **English first.** The code, the commits and the documentation are in
  English. The notes of the owner are in his language, the bot speaks two
  languages, and [README-ru.md](README-ru.md) is the Russian version of the
  README.
- **TypeScript, no `any`.** The types are checked with `npm run typecheck`.
- **Biome formats the code.** `npm run lint:fix` before every commit.

## The development

```bash
npm install
npm test          # the tests of Vitest
npm run lint      # Biome
npm run typecheck # the types
npm run build     # the build of the sources
```

The frontend of the Mini App lives in `web/`:

```bash
cd web
npm install
npm run build
npm run dev       # the dev server on the port 5173
```

The smoke test of a deployment runs the whole chain without Telegram:

```bash
node dist/selftest.js "an idea for a business"
```

## The commits

The messages are in the imperative mood and start with a kind of the change:

```
feat: the summary of the day in the file of the month
fix: do not lose the note when the file is locked
chore: the format of the sources
docs: the guide of the deployment
```

## The pull requests

1. Create a branch from `main`.
2. Make the change, add the tests, run `npm run lint && npm run typecheck && npm test`.
3. Open the pull request and describe what it changes and why.

A pull request is merged when the tests are green and a maintainer approved
it. Reviews that ask for a change are always welcome, they are not a fight.

## The reporting of the problems

Open an issue with one of the templates. A bug report is much easier to fix
when it has the version of the project, the version of Node.js and the part of
the log where the problem shows up.
