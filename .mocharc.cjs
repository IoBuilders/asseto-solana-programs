'use strict';

module.exports = {
  timeout: 1_000_000,
  require: ['tests/setup.ts'],
  spec: 'tests/**/*.ts',
  'node-option': ['import=tsx'],
};
