
console.log('Index.tsx loading...');

// Polyfill global
if (typeof (window as any).global === 'undefined') {
  (window as any).global = window;
}

// Debug fetch assignment
try {
  const originalFetch = window.fetch;
  Object.defineProperty(window, 'fetch', {
    get: () => originalFetch,
    set: (v) => {
      console.error('DETECTED FETCH ASSIGNMENT:', v);
      console.trace();
    },
    configurable: true
  });
} catch (e) {
  console.error('Could not redefine fetch:', e);
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

console.log('Index.tsx imports done');
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
