import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nodeExternals from 'webpack-node-externals'
import WebpackObfuscator from 'webpack-obfuscator'
import CopyPlugin from 'copy-webpack-plugin'

/*
 * Production build: bundles our own source (src/) into dist/ and obfuscates it, so the deployed
 * code is a handful of hard-to-read files instead of the readable project. Third-party packages stay
 * in node_modules (installed on the server with `npm ci --omit=dev`) rather than being bundled.
 *
 *   npm run build           -> dist/ (obfuscated server + scripts, plus sql/, package.json, .env.example)
 * On the server:  cd dist && npm ci --omit=dev && (create .env) && npm run db:migrate && npm start
 *
 * Note: this is obfuscation, not encryption. Node must be able to run the code, so it can be made hard
 * to read but never fully hidden. Keep .env (secrets) and this config out of what you hand over.
 */
const here = path.dirname(fileURLToPath(import.meta.url))

// The runtime package.json placed in dist: same dependencies, scripts pointing at the bundled files, no build tooling.
function distPackageJson(content) {
  const pkg = JSON.parse(content.toString())
  return JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: 'module',
      description: pkg.description,
      scripts: {
        start: 'node server.js',
        'db:init': 'node initDb.js',
        'db:migrate': 'node migrate.js',
        'pdf:base64': 'node pdfToBase64.js',
        'mail:test': 'node mailTest.js',
      },
      engines: pkg.engines,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  )
}

export default {
  mode: 'production',
  target: 'node20',
  devtool: false,
  entry: {
    server: './src/server.js',
    migrate: './src/scripts/migrate.js',
    initDb: './src/scripts/initDb.js',
    pdfToBase64: './src/scripts/pdfToBase64.js',
    mailTest: './src/scripts/mailTest.js',
  },
  output: {
    path: path.join(here, 'dist'),
    filename: '[name].js',
    module: true,
    chunkFormat: 'module',
    library: { type: 'module' },
    clean: true,
  },
  experiments: { outputModule: true, topLevelAwait: true },
  // Keep third-party packages external (required from node_modules at runtime), bundle only our code
  externalsPresets: { node: true },
  externalsType: 'node-commonjs',
  externals: [nodeExternals({ importType: 'node-commonjs' })],
  optimization: {
    minimize: false, // the obfuscator compacts the output; a separate minifier would fight it
  },
  plugins: [
    // Obfuscate only our bundled code. A moderate profile: strong enough to deter reading, light enough
    // to keep the server fast and stable. Turn on controlFlowFlattening / deadCodeInjection for more, at a cost.
    new WebpackObfuscator(
      {
        compact: true,
        identifierNamesGenerator: 'hexadecimal',
        numbersToExpressions: true,
        simplify: true,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        splitStrings: true,
        splitStringsChunkLength: 10,
        transformObjectKeys: true,
        renameGlobals: false,
        selfDefending: false,
        controlFlowFlattening: false,
        deadCodeInjection: false,
      },
      [], // no excludes: everything in the bundle is our own code
    ),
    new CopyPlugin({
      patterns: [
        { from: 'sql', to: 'sql' },
        { from: '.env.example', to: '.env.example' },
        { from: 'package.json', to: 'package.json', transform: distPackageJson },
      ],
    }),
  ],
}
