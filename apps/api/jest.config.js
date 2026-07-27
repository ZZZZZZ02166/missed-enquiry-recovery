/** @type {import('jest').Config} */
module.exports = {
  rootDir: 'src',
  testEnvironment: 'node',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['**/*.ts', '!**/generated/**', '!**/*.module.ts', '!main.ts', '!worker.ts'],
  // The generated Prisma client is large and never under test.
  testPathIgnorePatterns: ['/node_modules/', '/generated/'],
};
