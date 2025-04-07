import {StrictMode} from 'react';
import * as ReactDOMClient from 'react-dom/client';
import App from './App.tsx';

console.log(ReactDOMClient, 'ReactDOMClient');

ReactDOMClient.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
