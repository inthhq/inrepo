import { describe, expect, test } from 'bun:test';
import {
  ADD_PACKAGE_JSON_CHOICES,
  DEFAULT_ADD_PACKAGE_JSON_CHOICE,
} from './add.js';

describe('interactive add package.json choice', () => {
  test('defaults to source-only and offers both explicit dependency buckets', () => {
    expect(DEFAULT_ADD_PACKAGE_JSON_CHOICE).toBe('none');
    expect(ADD_PACKAGE_JSON_CHOICES).toEqual([
      { value: 'none', label: 'Do not link', hint: 'source vendoring only' },
      { value: 'dependencies', label: 'dependencies' },
      { value: 'devDependencies', label: 'devDependencies' },
    ]);
  });
});
