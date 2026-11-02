import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Model3DViewer, model3dUrl } from './Model3DViewer';

describe('Model3DViewer', () => {
  it('renders an accessible canvas and a loading status before three.js is loaded', () => {
    // Act
    const html = renderToStaticMarkup(<Model3DViewer src="/api/files/model3d?path=tree.glb" label="tree.glb" />);
    // Assert
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Modèle 3D : tree.glb"');
    expect(html).toMatch(/<canvas[^>]*role="img"[^>]*tabindex="0"/);
    expect(html).toContain('molette pour zoomer');
    expect(html).toContain('role="status"');
  });

  it('builds the confined .glb URL with the path and session encoded', () => {
    // Act / Assert
    expect(model3dUrl('out/a b.glb', 's_1')).toBe('/api/files/model3d?path=out%2Fa+b.glb&sessionId=s_1');
  });
});
