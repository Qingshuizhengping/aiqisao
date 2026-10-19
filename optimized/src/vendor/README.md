# Marked 18.0.9

`marked-18.0.9.mjs` is the unmodified `lib/marked.esm.js` from the official npm release of [Marked](https://marked.js.org/), distributed under its accompanying MIT license.

- Release: https://registry.npmjs.org/marked/18.0.9
- Archive: https://registry.npmjs.org/marked/-/marked-18.0.9.tgz
- Archive integrity: `sha512-/Sa4qiiHZxf0/FQdBBowr9q4r10krCwMvpK48FUBdXdUXScDxiQGR9zCPrFgRVR5LU3iySOiIjy09ZQvADir1w==`
- Original module SHA-256: `2c9b2113f8ef95ad21349952644fc1b3f759f0f92aff2ad4016a574b5ce19de5`

Build the browser/Node-compatible module from the repository root:

```sh
esbuild optimized/src/markdown.js --bundle --minify --format=esm --target=es2019 --outfile=optimized/public/static/js/markdown.mjs
```

Import `renderMarkdown` from `./markdown.js` in the frontend source and bundle the frontend entry with `--bundle`. The server can import the standalone built `public/static/js/markdown.mjs`; no runtime npm install is required. Preserve the vendored license when redistributing either bundle.

The application renderer escapes all raw HTML, allows only absolute HTTP(S) and mail links, and renders images as text without remote image requests. Its limited Chinese-bold extension accepts a trailing space before `**`, matching malformed model output without transforming fenced code, inline code, escaped asterisks, or arbitrary English/math text.
