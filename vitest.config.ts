import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['visual-bot/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'lcov'],
      reportsDirectory: './coverage',
      all: true,
      include: ['visual-bot/**/*.ts'],
      exclude: [
        'visual-bot/**/*.test.ts',
        'visual-bot/index.ts',
        'visual-bot/run-pipeline.ts',
        'visual-bot/run-adversarial.ts',
      ],
    },
  },
});
