# undici-cache-store-better-sqlite3

A undici cache store powered by `better-sqlite3` instead of `node:sqlite`.

## Installation

```bash
# npm
npm install undici-cache-store-better-sqlite3
# yarn
yarn add undici-cache-store-better-sqlite3
# pnpm
pnpm add undici-cache-store-better-sqlite3
```

## Usage

```typescript
import { BetterSqlite3CacheStore } from 'undici-cache-store-better-sqlite3';
import undici, {
  interceptors,
  Agent,
  setGlobalDispatcher
} from 'undici';

const agent = new Agent({});

setGlobalDispatcher(agent.compose(
  interceptors.cache({
    store: new BetterSqlite3CacheStore({
      /**
       * Location of the database
       * @default ':memory:'
       */
      location: ':memory:';
      /**
       * @default Infinity
       */
      maxCount: Infinity;
      /**
       * @default Infinity
       */
      maxEntrySize: Infinity;
    })
  })
));
```

## License

[MIT](./LICENSE)

----

**undici-cache-store-better-sqlite3** © [Sukka](https://github.com/SukkaW), Released under the [MIT](./LICENSE) License.
Authored and maintained by Sukka with help from contributors ([list](https://github.com/SukkaW/undici-cache-store-better-sqlite3/graphs/contributors)).

> [Personal Website](https://skk.moe) · [Blog](https://blog.skk.moe) · GitHub [@SukkaW](https://github.com/SukkaW) · Telegram Channel [@SukkaChannel](https://t.me/SukkaChannel) · Mastodon [@sukka@acg.mn](https://acg.mn/@sukka) · Twitter [@isukkaw](https://twitter.com/isukkaw) · Keybase [@sukka](https://keybase.io/sukka)

<p align="center">
  <a href="https://github.com/sponsors/SukkaW/">
    <img src="https://sponsor.cdn.skk.moe/sponsors.svg"/>
  </a>
</p>
