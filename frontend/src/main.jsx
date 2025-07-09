import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { BrowserRouter } from 'react-router-dom';
import Amplify from 'aws-amplify';
import awsConfig from './aws-exports';
import { Buffer } from 'buffer';
import './index.css';

window.Buffer = Buffer;
Amplify.configure(awsConfig);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
