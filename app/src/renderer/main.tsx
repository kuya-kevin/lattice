import { createRoot } from 'react-dom/client';
import { configureGlobalContext } from '@waveform-playlist/playout';
import { App } from './App';
import { createMockBridge } from './mockBridge';
import './styles.css';

// [S1 fx] effects are native Web Audio / AudioWorklet nodes: use a native AudioContext
// (must run before any audio is touched; waveform-playlist supports this mode)
configureGlobalContext({ nativeAudioContext: true });

// Electron provides window.lattice via preload; in a plain browser we install the mock.
const bridge = window.lattice ?? (window.lattice = createMockBridge());
createRoot(document.getElementById('root')!).render(<App bridge={bridge} />);
