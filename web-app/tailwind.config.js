/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#3D52A0',
          light: '#7091E6',
          wash: '#8697C4',
        },
        surface: '#ADBBDA',
        background: '#EDE8F5',
        charcoal: '#2D3142',
        slate: '#4F5D75',
        success: '#7FB069',
        warning: '#D4A03C',
        danger: '#C45B5B',
        accent: {
          product: '#6C63FF',
        },
        glass: {
          bg: 'rgba(255,255,255,0.6)',
          border: 'rgba(255,255,255,0.3)',
          shadow: 'rgba(61,82,160,0.08)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ["'JetBrains Mono'", "'Fira Code'", "'Cascadia Code'", 'monospace'],
      },
      borderRadius: {
        'glass': '16px',
      },
      backdropBlur: {
        'glass': '20px',
      },
      boxShadow: {
        'glass': '0 8px 32px rgba(61,82,160,0.08)',
        'glass-subtle': '0 4px 16px rgba(61,82,160,0.06)',
      },
    },
  },
  plugins: [],
}
