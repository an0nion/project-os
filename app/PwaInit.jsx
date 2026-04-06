'use client';

import { useEffect } from 'react';
import { initPWA }   from '../lib/pwa.js';

/** Registers the service worker on first client render. Renders nothing. */
export default function PwaInit() {
  useEffect(() => { initPWA(); }, []);
  return null;
}
