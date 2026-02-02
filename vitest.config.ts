import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Enable globals (describe, it, expect, etc.)
    globals: true,
    
    // Test environment
    environment: 'node',
    
    // Include patterns
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    
    // Exclude patterns
    exclude: [
      'node_modules',
      'dist',
      '.idea',
      '.git',
      '.cache'
    ],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      reportsDirectory: './coverage',
      
      // Files to include in coverage
      include: [
        'src/core/**/*.ts'
      ],
      
      // Files to exclude from coverage
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/index.ts'
      ],
      
      // Thresholds for CI pipeline
      thresholds: {
        global: {
          branches: 60,
          functions: 60,
          lines: 60,
          statements: 60
        },
        // Per-file thresholds for critical components
        perFile: true,
        '100': false
      }
    },
    
    // Watch mode configuration
    watch: true,
    watchExclude: ['node_modules', 'dist'],
    
    // Parallel execution
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false
      }
    },
    
    // Timeout for slow tests
    testTimeout: 10000,
    hookTimeout: 10000,
    
    // Reporter configuration
    reporters: ['verbose'],
    
    // Snapshot configuration
    snapshotFormat: {
      printBasicPrototype: false
    },
    
    // Retry failed tests
    retry: 0,
    
    // Bail on first failure in CI
    bail: process.env.CI ? 1 : 0,
    
    // Setup files
    setupFiles: [],
    
    // Global setup/teardown
    globalSetup: undefined,
    globalTeardown: undefined
  },
  
  // Resolve configuration
  resolve: {
    alias: {
      '@': '/src',
      '@core': '/src/core',
      '@cpu': '/src/core/cpu',
      '@ppu': '/src/core/ppu',
      '@apu': '/src/core/apu',
      '@chips': '/src/core/chips',
      '@memory': '/src/core/memory'
    }
  }
});
