/** @type {import('tailwindcss').Config} */
import defaultTheme from 'tailwindcss/defaultTheme';
import typography from '@tailwindcss/typography';

export default {
	content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
	darkMode: 'class',
	theme: {
		extend: {
			fontFamily: {
				sans: ['NanumSquare', 'system-ui', 'sans-serif'],
				serif: ['NanumSquare', 'Georgia', 'serif'],
			},
			colors: {
				brand: {
					navy: '#003366',
					paper: '#fdfcfb',
					charcoal: '#121212',
				}
			},
		},
	},
	plugins: [typography],
};
