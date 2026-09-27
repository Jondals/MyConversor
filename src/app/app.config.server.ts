// Server providers used when prerendering the page.
import { ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/ssr';
import { appConfig } from './app.config';

// Single page: prerendered once at build time (SSG) so the first paint needs no JavaScript.
const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
