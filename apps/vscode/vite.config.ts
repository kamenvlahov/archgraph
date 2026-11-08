import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Разширението е CommonJS за extension host-а на VS Code. `vscode` и модулите на Node са външни.
export default defineConfig({
  build: {
    lib: { entry: 'src/extension.ts', formats: ['cjs'], fileName: () => 'extension.cjs' },
    outDir: 'dist',
    target: 'node20',
    minify: false,
    rollupOptions: { external: ['vscode', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)] },
  },
});
