import { cleanupContext } from './context';

export default async function globalTeardown(): Promise<void> {
  cleanupContext();
}
