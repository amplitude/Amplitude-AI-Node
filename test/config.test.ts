import { AIConfig, ContentMode } from '@amplitude/ai';
import { describe, expect, it } from 'vitest';

describe('AIConfig', () => {
  describe('default values', () => {
    it('uses FULL contentMode by default', (): void => {
      const config = new AIConfig();
      expect(config.contentMode).toBe(ContentMode.FULL);
    });

    it('uses debug=false by default', (): void => {
      const config = new AIConfig();
      expect(config.debug).toBe(false);
    });

    it('uses redactPii=false by default', (): void => {
      const config = new AIConfig();
      expect(config.redactPii).toBe(false);
    });

    it('uses dryRun=false by default', (): void => {
      const config = new AIConfig();
      expect(config.dryRun).toBe(false);
    });

    it('uses validate=false by default', (): void => {
      const config = new AIConfig();
      expect(config.validate).toBe(false);
    });

    it('uses propagateContext=false by default', (): void => {
      const config = new AIConfig();
      expect(config.propagateContext).toBe(false);
    });

    it('uses onEventCallback=null by default', (): void => {
      const config = new AIConfig();
      expect(config.onEventCallback).toBeNull();
    });

    it('uses empty customRedactionPatterns by default', (): void => {
      const config = new AIConfig();
      expect(config.customRedactionPatterns).toEqual([]);
    });
  });

  describe('custom values', () => {
    it('accepts custom contentMode', (): void => {
      const config = new AIConfig({ contentMode: ContentMode.METADATA_ONLY });
      expect(config.contentMode).toBe(ContentMode.METADATA_ONLY);
    });

    it('accepts custom debug', (): void => {
      const config = new AIConfig({ debug: true });
      expect(config.debug).toBe(true);
    });

    it('accepts custom redactPii', (): void => {
      const config = new AIConfig({ redactPii: true });
      expect(config.redactPii).toBe(true);
    });

    it('accepts custom dryRun', (): void => {
      const config = new AIConfig({ dryRun: true });
      expect(config.dryRun).toBe(true);
    });

    it('accepts custom validate', (): void => {
      const config = new AIConfig({ validate: true });
      expect(config.validate).toBe(true);
    });

    it('accepts custom propagateContext', (): void => {
      const config = new AIConfig({ propagateContext: true });
      expect(config.propagateContext).toBe(true);
    });

    it('accepts custom onEventCallback', (): void => {
      const cb = (): void => {};
      const config = new AIConfig({ onEventCallback: cb });
      expect(config.onEventCallback).toBe(cb);
    });

    it('accepts custom customRedactionPatterns', (): void => {
      const patterns = ['foo', 'bar'];
      const config = new AIConfig({ customRedactionPatterns: patterns });
      expect(config.customRedactionPatterns).toEqual(patterns);
    });
  });

  describe('toPrivacyConfig', () => {
    it('creates PrivacyConfig with privacyMode=false for FULL contentMode', (): void => {
      const config = new AIConfig({ contentMode: ContentMode.FULL });
      const privacy = config.toPrivacyConfig();
      expect(privacy.privacyMode).toBe(false);
      expect(privacy.redactPii).toBe(false);
      expect(privacy.contentMode).toBe('full');
    });

    it('creates PrivacyConfig with privacyMode=true for METADATA_ONLY contentMode', (): void => {
      const config = new AIConfig({ contentMode: ContentMode.METADATA_ONLY });
      const privacy = config.toPrivacyConfig();
      expect(privacy.privacyMode).toBe(true);
      expect(privacy.contentMode).toBe('metadata_only');
    });

    it('creates PrivacyConfig with privacyMode=true for CUSTOMER_ENRICHED contentMode', (): void => {
      const config = new AIConfig({
        contentMode: ContentMode.CUSTOMER_ENRICHED,
      });
      const privacy = config.toPrivacyConfig();
      expect(privacy.privacyMode).toBe(true);
      expect(privacy.contentMode).toBe('customer_enriched');
    });

    it('passes redactPii and customRedactionPatterns to PrivacyConfig', (): void => {
      const config = new AIConfig({
        redactPii: true,
        customRedactionPatterns: ['email', 'phone'],
      });
      const privacy = config.toPrivacyConfig();
      expect(privacy.redactPii).toBe(true);
      expect(privacy.customPatterns).toEqual(['email', 'phone']);
    });

    it('passes validate and debug to PrivacyConfig', (): void => {
      const config = new AIConfig({ validate: true, debug: true });
      const privacy = config.toPrivacyConfig();
      expect(privacy.validate).toBe(true);
      expect(privacy.debug).toBe(true);
    });
  });
});
