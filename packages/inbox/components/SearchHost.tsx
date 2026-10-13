/**
 * Where Inbox search's palette lives in the window: its code loads through
 * one dynamic import of `#search-palette` (packages/inbox/search/SearchPalette.tsx),
 * mounted on the first open with no fallback UI and kept mounted after (as
 * Workspaces' AppShell does), so the palette never rides the window's first
 * paint. tests/entry-assets.test.ts keeps every other import of it out.
 */

import { lazy, Suspense } from 'react';
import type { SearchPaletteProps } from '../search/SearchPalette';

const SearchPalette = lazy(() => import('#search-palette'));

export type { SearchLanding } from '../search/SearchPalette';

export function SearchHost(props: SearchPaletteProps & { mounted: boolean }) {
  const { mounted, ...palette } = props;
  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <SearchPalette {...palette} />
    </Suspense>
  );
}
