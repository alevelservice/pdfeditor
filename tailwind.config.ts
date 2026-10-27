import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eef4ff', 100: '#d9e6ff', 500: '#3b6ef5', 600: '#2c58d6', 700: '#2346ab' },
      },
    },
  },
  plugins: [],
};
export default config;
