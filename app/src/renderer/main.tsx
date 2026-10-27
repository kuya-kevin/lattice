import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMockBridge } from './mockBridge';
import './styles.css';

// Electron provides window.lattice via preload; in a plain browser we install the mock.
const bridge = window.lattice ?? (window.lattice = createMockBridge());
createRoot(document.getElementById('root')!).render(<App bridge={bridge} />);
