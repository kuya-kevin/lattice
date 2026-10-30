import { createRoot } from 'react-dom/client';
import { configureGlobalContext } from '@waveform-playlist/playout';
import { App } from './App';
import { buffers } from './audio';
import { createMockBridge } from './mockBridge';
import { voiceReplyFor } from './voiceReply';
import '@fontsource-variable/instrument-sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';

// [S1 fx] effects are native Web Audio / AudioWorklet nodes: use a native AudioContext
// (must run before any audio is touched; waveform-playlist supports this mode)
configureGlobalContext({ nativeAudioContext: true });

// Electron provides window.lattice via preload; in a plain browser we install the mock.
const bridge = window.lattice ?? (window.lattice = createMockBridge());
voiceReplyFor(bridge.mode); // B14: Muse's spoken replies (installs window.latticeVoice before the page loads)
// read-only peek for tests: which sources have audio in this window (B11 restore checks)
(window as unknown as { latticeDebug: object }).latticeDebug = { audioIds: () => [...buffers.keys()] };
createRoot(document.getElementById('root')!).render(<App bridge={bridge} />);
