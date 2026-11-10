#!/usr/bin/env node
'use strict';

const { main } = require('../lib/agys.js');

Promise.resolve(main(process.argv.slice(2))).catch((err) => {
  process.stderr.write(`agys: ${err.message}\n`);
  process.exit(1);
});
