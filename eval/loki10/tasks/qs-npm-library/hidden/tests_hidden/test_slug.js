'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const root = process.cwd();
let pkg;
try {
  pkg = require(path.join(root, 'package.json'));
} catch (e) {
  console.log('FAIL: package.json missing or invalid: ' + e.message.split('\n')[0]);
  process.exit(1);
}

try {
  assert.equal(pkg.name, 'tiny-slug', 'package name');
  const lib = require(root);
  assert.equal(typeof lib.slugify, 'function', 'slugify export');
  const { slugify } = lib;
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Crème brûlée  recipe '), 'creme-brulee-recipe');
  assert.equal(slugify('a--b__c'), 'a-b-c');
  assert.equal(slugify('Hello World', { separator: '_' }), 'hello_world');
  assert.equal(slugify('The Quick Brown Fox', { maxLength: 9 }), 'the-quick');
  assert.equal(slugify('The Quick Brown Fox', { maxLength: 10 }), 'the-quick');
  assert.equal(slugify('!!!'), '');
  assert.throws(() => slugify(42), TypeError);
} catch (e) {
  console.log('FAIL: ' + e.message);
  process.exit(1);
}
console.log('PASS');
