import { describe, it, expect } from 'vitest';
import { toCleanDescription } from '../lib/review-text';

describe('toCleanDescription', () => {
  it('turns paragraphs into blank lines and line breaks into new lines', () => {
    expect(toCleanDescription('<p>First paragraph.</p><p>Second line one<br/>line two</p>')).toBe(
      'First paragraph.\n\nSecond line one\nline two',
    );
  });

  it('removes inline tags and decodes entities', () => {
    expect(toCleanDescription('<p><b>Winner</b> of the <i>Costa</i> &amp; more&hellip;</p>')).toBe('Winner of the Costa & more…');
  });

  it('removes markup that was itself entity-encoded, even twice', () => {
    expect(toCleanDescription('&lt;p&gt;Praise&lt;/p&gt;&lt;p&gt;Second&lt;/p&gt;')).toBe('Praise\n\nSecond');
    expect(toCleanDescription('author of &amp;quot;Leadership&amp;quot;')).toBe('author of "Leadership"');
  });

  it('drops the space runs some feeds put after an entity', () => {
    expect(toCleanDescription('Wainwright&#8217;             s guide, 1955&#8211;             66')).toBe('Wainwright’s guide, 1955–66');
  });

  it('keeps list items as bullets', () => {
    expect(toCleanDescription('<p>Includes:</p><ul><li>Maps</li><li>Recipes</li></ul>')).toBe('Includes:\n\n• Maps\n• Recipes');
  });

  it('repairs the SQL-style doubled quotes from the feed', () => {
    expect(toCleanDescription("Tennessee Williams''s play")).toBe("Tennessee Williams's play");
  });

  it('leaves a description with no markup unchanged, and is idempotent', () => {
    const plain = 'A quiet story.\n\nAbout a family farm & its people.';
    expect(toCleanDescription(plain)).toBe(plain);
    const messy = '<div>&lt;b&gt;One&lt;/b&gt;</div><p>Two<br>Three</p>';
    expect(toCleanDescription(toCleanDescription(messy))).toBe(toCleanDescription(messy));
  });

  it('returns an empty string for markup with no text', () => {
    expect(toCleanDescription('<p> </p><br/>')).toBe('');
  });
});
