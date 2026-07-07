import {
  permutiveSubmodule,
  storage,
  isPermutiveOnPage,
  setBidderRtb,
  getModuleConfig,
  PERMUTIVE_SUBMODULE_CONFIG_KEY,
  PERMUTIVE_COHORTS_KEY,
  PERMUTIVE_STANDARD_KEYWORD,
  PERMUTIVE_STANDARD_AUD_KEYWORD,
  PERMUTIVE_CUSTOM_COHORTS_KEYWORD,
} from 'modules/permutiveRtdProvider.js';
import { deepSetValue, mergeDeep } from '../../../src/utils.js';
import { config } from 'src/config.js';
import { permutiveIdentityManagerIdSubmodule, storage as permutiveIdStorage } from '../../../modules/permutiveIdentityManagerIdSystem.js';

describe('permutiveRtdProvider', function () {
  beforeEach(function () {
    // Legacy keys are placed in localStorage to prove the module ignores them
    setLocalStorage(getLegacyTargetingData());
    config.resetConfig();
  });

  afterEach(function () {
    removeLocalStorage(getLegacyTargetingData());
    storage.removeDataFromLocalStorage(PERMUTIVE_COHORTS_KEY);
    config.resetConfig();
  });

  describe('permutiveSubmodule', function () {
    it('should initialise and return true', function () {
      expect(permutiveSubmodule.init()).to.equal(true);
    });
  });

  describe('consent handling', function () {
    const publisherPurposeConsent = {
      gdpr: {
        gdprApplies: true,
        vendorData: {
          publisher: { consents: { 1: true }, legitimateInterests: {} },
          vendor: { consents: {}, legitimateInterests: {} },
          purpose: { consents: {}, legitimateInterests: {} },
        }
      }
    };

    const vendorPurposeConsent = {
      gdpr: {
        gdprApplies: true,
        vendorData: {
          publisher: { consents: {}, legitimateInterests: {} },
          vendor: { consents: { 361: true }, legitimateInterests: {} },
          purpose: { consents: { 1: true }, legitimateInterests: {} },
        }
      }
    };

    const missingVendorConsent = {
      gdpr: {
        gdprApplies: true,
        vendorData: {
          publisher: { consents: { 1: true }, legitimateInterests: {} },
          vendor: { consents: {}, legitimateInterests: {} },
          purpose: { consents: { 1: true }, legitimateInterests: {} },
        }
      }
    };

    it('allows publisher consent path when vendor check is disabled', function () {
      expect(permutiveSubmodule.init({}, publisherPurposeConsent)).to.equal(true);
    });

    it('requires vendor consent when enforceVendorConsent is enabled', function () {
      expect(permutiveSubmodule.init({ params: { enforceVendorConsent: true } }, missingVendorConsent)).to.equal(false);
    });

    it('allows vendor consent path when enforceVendorConsent is enabled', function () {
      expect(permutiveSubmodule.init({ params: { enforceVendorConsent: true } }, vendorPurposeConsent)).to.equal(true);
    });

    describe('identity manager gating', function () {
      const idKey = 'permutive-prebid-id';
      const idPayload = { providers: { id5id: { userId: 'abc', expiryTime: Date.now() + 10000 } } };

      beforeEach(function () {
        permutiveIdStorage.setDataInLocalStorage(idKey, JSON.stringify(idPayload));
      });

      afterEach(function () {
        permutiveIdStorage.removeDataFromLocalStorage(idKey);
      });

      it('returns ids with publisher consent when vendor enforcement is disabled', function () {
        const response = permutiveIdentityManagerIdSubmodule.getId({}, publisherPurposeConsent);

        expect(response).to.deep.equal({ id: { id5id: 'abc' } });
      });

      it('blocks ids when vendor consent is missing and enforcement is enabled', function () {
        const response = permutiveIdentityManagerIdSubmodule.getId({ params: { enforceVendorConsent: true } }, missingVendorConsent);

        expect(response).to.be.undefined;
      });

      it('returns ids when vendor consent is present and enforcement is enabled', function () {
        const response = permutiveIdentityManagerIdSubmodule.getId({ params: { enforceVendorConsent: true } }, vendorPurposeConsent);

        expect(response).to.deep.equal({ id: { id5id: 'abc' } });
      });
    });
  });

  describe('getModuleConfig', function () {
    beforeEach(function () {
      // Reads data from the cache
      permutiveSubmodule.init();
    });

    const liftToParams = (params) => ({ params });

    const getDefaultConfig = () => ({
      waitForIt: false,
      params: {
        maxSegs: 500,
        enforceVendorConsent: false,
        bidders: {},
      },
    });

    const storeConfigInCacheAndInit = (data) => {
      const dataToStore = { [PERMUTIVE_SUBMODULE_CONFIG_KEY]: data };
      setLocalStorage(dataToStore);
      // Reads data from the cache
      permutiveSubmodule.init();

      // Cleanup
      return () => removeLocalStorage(dataToStore);
    };

    const setWindowPermutivePrebid = (getPermutiveRtdConfig) => {
      // Read from Permutive
      const backup = window.permutive;

      deepSetValue(window, 'permutive.addons.prebid', {
        getPermutiveRtdConfig,
      });

      // Cleanup
      return () => window.permutive = backup;
    };

    it('should return default values', function () {
      const config = getModuleConfig({});
      expect(config).to.deep.equal(getDefaultConfig());
    });

    it('should override deeply on custom config', function () {
      const defaultConfig = getDefaultConfig();

      const customModuleConfig = { waitForIt: true, params: { maxSegs: 250 } };
      const config = getModuleConfig(customModuleConfig);

      expect(config).to.deep.equal(mergeDeep(defaultConfig, customModuleConfig));
    });

    it('should override deeply on cached config', function () {
      const defaultConfig = getDefaultConfig();

      const cachedParamsConfig = { maxSegs: 250 };
      const cleanupCache = storeConfigInCacheAndInit(cachedParamsConfig);

      const config = getModuleConfig({});

      expect(config).to.deep.equal(mergeDeep(defaultConfig, liftToParams(cachedParamsConfig)));

      // Cleanup
      cleanupCache();
    });

    it('should override deeply on Permutive Rtd config', function () {
      const defaultConfig = getDefaultConfig();

      const permutiveRtdConfigParams = {
        maxSegs: 250,
        bidders: { appnexus: { customCohorts: { source: 'ls', key: PERMUTIVE_COHORTS_KEY, path: 'activations.ortb2.appnexus' } } },
      };
      const cleanupPermutive = setWindowPermutivePrebid(function () {
        return permutiveRtdConfigParams;
      });

      const config = getModuleConfig({});

      expect(config).to.deep.equal(mergeDeep(defaultConfig, liftToParams(permutiveRtdConfigParams)));

      // Cleanup
      cleanupPermutive();
    });

    it('should NOT use cached Permutive Rtd config if window.permutive is available', function () {
      const defaultConfig = getDefaultConfig();

      // As Permutive is available on the window object, this value won't be used.
      const cachedParamsConfig = { maxSegs: 250 };
      const cleanupCache = storeConfigInCacheAndInit(cachedParamsConfig);

      const permutiveRtdConfigParams = { maxSegs: 100 };
      const cleanupPermutive = setWindowPermutivePrebid(function () {
        return permutiveRtdConfigParams;
      });

      const config = getModuleConfig({});

      expect(config).to.deep.equal(mergeDeep(defaultConfig, liftToParams(permutiveRtdConfigParams)));

      // Cleanup
      cleanupCache();
      cleanupPermutive();
    });

    it('should handle calling Permutive method throwing error', function () {
      const defaultConfig = getDefaultConfig();

      const cleanupPermutive = setWindowPermutivePrebid(function () {
        throw new Error();
      });

      const config = getModuleConfig({});

      expect(config).to.deep.equal(defaultConfig);

      // Cleanup
      cleanupPermutive();
    });

    it('should override deeply in priority order', function () {
      const defaultConfig = getDefaultConfig();

      // As Permutive is available on the window object, this value won't be used.
      const cachedConfig = { maxSegs: 400 };
      const cleanupCache = storeConfigInCacheAndInit(cachedConfig);

      // Read from Permutive
      const permutiveRtdConfig = { maxSegs: 450 };
      const cleanupPermutive = setWindowPermutivePrebid(function () {
        return permutiveRtdConfig;
      });

      const customModuleConfig = { params: { maxSegs: 499 } };
      const config = getModuleConfig(customModuleConfig);

      // The configs are in reverse priority order as configs are merged left to right. So the priority is,
      // 1. customModuleConfig <- set by publisher with pbjs.setConfig
      // 2. permutiveRtdConfig <- set by the publisher using Permutive.
      // 3. defaultConfig
      const configMergedInPriorityOrder = mergeDeep(defaultConfig, liftToParams(permutiveRtdConfig), customModuleConfig);
      expect(config).to.deep.equal(configMergedInPriorityOrder);

      // Cleanup
      cleanupCache();
      cleanupPermutive();
    });
  });

  describe('SDK-driven cohort routing (_pcohorts)', function () {
    const setCohortStore = (store) => {
      storage.setDataInLocalStorage(PERMUTIVE_COHORTS_KEY, JSON.stringify(store));
    };

    const defaultModuleConfig = (extraParams = {}) => ({
      name: 'permutive',
      params: {
        maxSegs: 500,
        ...extraParams,
      }
    });

    it('should route cohorts for every bidder in the store without any bidder configuration', function () {
      setCohortStore({
        categories: { standard: ['s1', 's2'], custom: ['x1'] },
        activations: {
          ortb2: {
            appnexus: ['s1', 's2', 'x1'],
            rubicon: ['x1'],
          }
        },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['appnexus'].user.data).to.deep.include.members([
        { name: 'permutive.com', segment: [{ id: 's1' }, { id: 's2' }] },
        { name: 'permutive', segment: [{ id: 'x1' }] },
      ]);
      expect(bidderConfig['rubicon'].user.data).to.deep.equal([
        { name: 'permutive', segment: [{ id: 'x1' }] },
      ]);
      expect(bidderConfig['rubicon'].user.keywords).to.equal('permutive=x1');
    });

    it('should place cohorts per category using the default placement policy', function () {
      setCohortStore({
        categories: {
          standard: ['s1'],
          dcr: ['d1'],
          curated: ['c1'],
          clm: ['m1'],
          custom: ['x1'],
        },
        activations: { ortb2: { msft: ['s1', 'd1', 'c1', 'x1', 'm1'] } },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['msft'].user.data).to.deep.include.members([
        {
          name: 'permutive.com',
          segment: [{ id: 's1' }, { id: 'd1' }, { id: 'c1' }],
        },
        {
          name: 'permutive',
          segment: [{ id: 'x1' }, { id: 'm1' }],
        },
      ]);
      expect(bidderConfig['msft'].user.keywords).to.equal(
        'p_standard=s1,p_standard=d1,p_standard=c1,p_standard_aud=c1,permutive=x1,permutive=m1'
      );
      expect(bidderConfig['msft'].user.ext.data).to.deep.equal({
        p_standard: ['s1', 'd1', 'c1'],
        permutive: ['x1', 'm1'],
      });
      expect(bidderConfig['msft'].site.ext.permutive.p_standard).to.deep.equal(['s1', 'd1', 'c1']);
    });

    it('should write nothing when only legacy localStorage keys are present', function () {
      // The legacy keys set in beforeEach are the only Permutive data available
      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig).to.deep.equal({});
    });

    it('should send p_standard_aud keywords only for curated cohorts', function () {
      setCohortStore({
        categories: { standard: ['s1'], curated: ['c1'] },
        activations: {
          ortb2: {
            foo: ['s1', 'c1'],
            bar: ['s1'],
          }
        },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['foo'].user.keywords).to.include(`${PERMUTIVE_STANDARD_AUD_KEYWORD}=c1`);
      expect(bidderConfig['bar'].user.keywords).to.not.include(PERMUTIVE_STANDARD_AUD_KEYWORD);
    });

    it('should drop references that resolve to no category', function () {
      setCohortStore({
        categories: { standard: ['s1'] },
        activations: { ortb2: { msft: ['s1', 'ghost'] } },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['msft'].user.keywords).to.equal('p_standard=s1');
      expect(JSON.stringify(bidderConfig['msft'])).to.not.include('ghost');
    });

    it('should honour a per-bidder placement override', function () {
      setCohortStore({
        categories: { standard: ['s1'] },
        activations: { ortb2: { msft: ['s1'] } },
      });

      const moduleConfig = defaultModuleConfig({
        bidders: { msft: { placement: { standard: ['pstd_kw'] } } },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, moduleConfig);

      expect(bidderConfig['msft'].user.keywords).to.equal('p_standard=s1');
      expect(bidderConfig['msft'].user).to.not.have.property('data');
      expect(bidderConfig['msft'].user).to.not.have.property('ext');
      expect(bidderConfig['msft']).to.not.have.property('site');
    });

    it('should support publisher-defined locations, keeping entries with different ext separate', function () {
      setCohortStore({
        categories: { standard: ['s1'], custom: ['x1'] },
        activations: { ortb2: { msft: ['s1', 'x1'] } },
      });

      const moduleConfig = defaultModuleConfig({
        locations: {
          topics600: { path: 'user.data', name: 'permutive.com', ext: { segtax: 600 } },
        },
        placement: {
          custom: ['topics600'],
        },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, moduleConfig);

      expect(bidderConfig['msft'].user.data).to.deep.include.members([
        {
          name: 'permutive.com',
          segment: [{ id: 's1' }],
        },
        {
          name: 'permutive.com',
          ext: { segtax: 600 },
          segment: [{ id: 'x1' }],
        },
      ]);
    });

    it('should skip unknown location ids and apply the rest', function () {
      setCohortStore({
        categories: { standard: ['s1'] },
        activations: { ortb2: { msft: ['s1'] } },
      });

      const moduleConfig = defaultModuleConfig({
        placement: { standard: ['pstd_kw', 'nonexistent'] },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, moduleConfig);

      expect(bidderConfig['msft'].user.keywords).to.equal('p_standard=s1');
    });

    it('should ignore a malformed cohort store', function () {
      setCohortStore(['not', 'an', 'object']);

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig).to.deep.equal({});
    });

    it('should read a flat cohort list as custom cohorts when customCohorts has no path', function () {
      // _papns is set by the beforeEach legacy fixture
      const moduleConfig = defaultModuleConfig({
        bidders: {
          msft: { customCohorts: { source: 'ls', key: '_papns' } },
        },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, moduleConfig);

      expect(bidderConfig['msft'].user.data).to.deep.equal([
        { name: 'permutive', segment: [{ id: 'appnexus1' }, { id: 'appnexus2' }] },
      ]);
      expect(bidderConfig['msft'].user.keywords).to.equal('permutive=appnexus1,permutive=appnexus2');
      expect(bidderConfig['msft'].user.ext.data.permutive).to.deep.equal(['appnexus1', 'appnexus2']);
    });

    it('should resolve a customCohorts path against that store\'s categories', function () {
      setCohortStore({
        categories: { standard: ['s1'] },
        activations: { ortb2: { someOtherName: ['s1'] } },
      });

      const moduleConfig = defaultModuleConfig({
        bidders: {
          msft: { customCohorts: { source: 'ls', key: PERMUTIVE_COHORTS_KEY, path: 'activations.ortb2.someOtherName' } },
        },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, moduleConfig);

      expect(bidderConfig['msft'].user.keywords).to.equal('p_standard=s1');
    });

    it('should not overwrite unrelated ortb2 config', function () {
      setCohortStore({
        categories: { standard: ['s1'] },
        activations: { ortb2: { appnexus: ['s1'] } },
      });

      const sampleOrtbConfig = {
        site: { name: 'example' },
        user: {
          data: [
            {
              name: 'www.dataprovider1.com',
              ext: { taxonomyname: 'iab_audience_taxonomy' },
              segment: [{ id: '687' }, { id: '123' }]
            }
          ]
        }
      };

      const bidderConfig = { appnexus: sampleOrtbConfig };
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['appnexus'].site.name).to.equal('example');
      expect(bidderConfig['appnexus'].user.data).to.deep.include.members([sampleOrtbConfig.user.data[0]]);
    });

    it('should replace existing ortb2.user.data entries reserved by permutive RTD', function () {
      setCohortStore({
        categories: { standard: ['s1'], custom: ['x1'] },
        activations: { ortb2: { appnexus: ['s1', 'x1'] } },
      });

      const sampleOrtbConfig = {
        user: {
          data: [
            { name: 'permutive', segment: [{ id: 'remove-me' }] },
            { name: 'permutive.com', segment: [{ id: 'remove-me-also' }] },
          ]
        }
      };

      const bidderConfig = { appnexus: sampleOrtbConfig };
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['appnexus'].user.data).to.not.deep.include.members([...sampleOrtbConfig.user.data]);
      expect(bidderConfig['appnexus'].user.data).to.deep.include.members([
        { name: 'permutive.com', segment: [{ id: 's1' }] },
        { name: 'permutive', segment: [{ id: 'x1' }] },
      ]);
    });

    it('should preserve and deduplicate existing user.keywords', function () {
      setCohortStore({
        categories: { standard: ['s1', 's2'] },
        activations: { ortb2: { appnexus: ['s1', 's2'] } },
      });

      const bidderConfig = {
        appnexus: {
          user: { keywords: `testKeyword,${PERMUTIVE_STANDARD_KEYWORD}=s1` },
        },
      };
      setBidderRtb(bidderConfig, defaultModuleConfig());

      expect(bidderConfig['appnexus'].user.keywords).to.equal(
        `testKeyword,${PERMUTIVE_STANDARD_KEYWORD}=s1,${PERMUTIVE_STANDARD_KEYWORD}=s2`
      );
    });

    it('should coerce cohort IDs to strings and enforce maxSegs per location', function () {
      setCohortStore({
        categories: { custom: [1, 2, 3] },
        activations: { ortb2: { msft: [1, 2, 3] } },
      });

      const bidderConfig = {};
      setBidderRtb(bidderConfig, defaultModuleConfig({ maxSegs: 2 }));

      expect(bidderConfig['msft'].user.ext.data[PERMUTIVE_CUSTOM_COHORTS_KEYWORD]).to.deep.equal(['1', '2']);
    });
  });

  describe('Permutive on page', function () {
    it('checks if Permutive is on page', function () {
      expect(isPermutiveOnPage()).to.equal(false);
    });
  });
});

function setLocalStorage (data) {
  for (const key in data) {
    storage.setDataInLocalStorage(key, JSON.stringify(data[key]));
  }
}

function removeLocalStorage (data) {
  for (const key in data) {
    storage.removeDataFromLocalStorage(key);
  }
}

/**
 * Legacy localStorage keys that older versions of this module used to read.
 * They are set in the test environment to prove the module ignores them.
 */
function getLegacyTargetingData () {
  return {
    _pdfps: ['gam1', 'gam2'],
    _prubicons: ['rubicon1', 'rubicon2'],
    _papns: ['appnexus1', 'appnexus2'],
    _psegs: ['1234', '1000001', '1000002'],
    _ppam: ['ppam1', 'ppam2'],
    _pindexs: ['pindex1', 'pindex2'],
    _pcrprs: ['pcrprs1', 'pcrprs2', 'dup'],
    _pssps: { ssps: ['xyz', 'abc', 'dup'], cohorts: ['123', 'abc'] },
    _ppsts: { '600': [1, 2, 3], '601': [100, 101, 102] },
  };
}

describe('permutiveIdentityManagerIdSystem', () => {
  const STORAGE_KEY = 'permutive-prebid-id';

  afterEach(() => {
    storage.removeDataFromLocalStorage(STORAGE_KEY);
  });

  describe('decode', () => {
    it('returns the input unchanged for most IDs', () => {
      const input = {
        id5id: {
          uid: '0',
          ext: {
            abTestingControlGroup: false,
            linkType: 2,
            pba: 'somepba'
          }
        }
      };
      const result = permutiveIdentityManagerIdSubmodule.decode(input);
      expect(result).to.be.equal(input);
    });

    it('decodes the base64-encoded array for pairId', () => {
      const input = {
        pairId: 'WyJBeVhiNUF0dmsvVS8xQ1d2ejJuRVk5aFl4T1g3TVFPUTJVQk1BMFdiV1ZFbSJd'
      };
      const result = permutiveIdentityManagerIdSubmodule.decode(input);
      const expected = {
        pairId: ["AyXb5Atvk/U/1CWvz2nEY9hYxOX7MQOQ2UBMA0WbWVEm"]
      };
      expect(result).to.deep.equal(expected);
    });
  });

  describe('getId', () => {
    it('returns relevant IDs from localStorage and does not return unexpected IDs', () => {
      const data = getUserIdData();
      storage.setDataInLocalStorage(STORAGE_KEY, JSON.stringify(data));
      const result = permutiveIdentityManagerIdSubmodule.getId({});
      const expected = {
        'id': {
          'id5id': {
            'uid': '0',
            'linkType': 0,
            'ext': {
              'abTestingControlGroup': false,
              'linkType': 0,
              'pba': 'EVqgf9vY0fSrsrqJZMOm+Q=='
            }
          }
        }
      };
      expect(result).to.deep.equal(expected);
    });

    it('handles idl_env without pairId', () => {
      const data = {
        'providers': {
          'idl_env': {
            'userId': 'ats_envelope_value'
          }
        }
      };
      storage.setDataInLocalStorage(STORAGE_KEY, JSON.stringify(data));
      const result = permutiveIdentityManagerIdSubmodule.getId({});
      const expected = {
        'id': {
          'idl_env': 'ats_envelope_value'
        }
      };
      expect(result).to.deep.equal(expected);
    });

    it('handles idl_env with pairId', () => {
      const data = {
        'providers': {
          'idl_env': {
            'userId': 'ats_envelope_value',
          },
          'pairId': {
            'userId': 'pair_id_encoded_value'
          }
        }
      };
      storage.setDataInLocalStorage(STORAGE_KEY, JSON.stringify(data));
      const result = permutiveIdentityManagerIdSubmodule.getId({});
      const expected = {
        'id': {
          'idl_env': 'ats_envelope_value',
          'pairId': 'pair_id_encoded_value'
        }
      };
      expect(result).to.deep.equal(expected);
    });

    it('returns undefined if no relevant IDs are found in localStorage', () => {
      storage.setDataInLocalStorage(STORAGE_KEY, '{}');
      const result = permutiveIdentityManagerIdSubmodule.getId({});
      expect(result).to.be.undefined;
    });

    it('will optionally wait for Permutive SDK if no identities are in local storage already', async () => {
      const cleanup = setWindowPermutive();
      try {
        const result = permutiveIdentityManagerIdSubmodule.getId({ params: { ajaxTimeout: 300 } });
        expect(result).not.to.be.undefined;
        expect(result.id).to.be.undefined;
        expect(result.callback).not.to.be.undefined;
        const expected = {
          'id5id': {
            'uid': '0',
            'linkType': 0,
            'ext': {
              'abTestingControlGroup': false,
              'linkType': 0,
              'pba': 'EVqgf9vY0fSrsrqJZMOm+Q=='
            }
          }
        };
        const r = await new Promise(result.callback);
        expect(r).to.deep.equal(expected);
      } finally {
        cleanup();
      }
    });
  });
});

const setWindowPermutive = () => {
  // Read from Permutive
  const backup = window.permutive;

  deepSetValue(window, 'permutive.ready', (f) => {
    setTimeout(() => f(), 5);
  });

  deepSetValue(window, 'permutive.addons.identity_manager.prebid.onReady', (f) => {
    setTimeout(() => f(sdkUserIdData()), 5);
  });

  // Cleanup
  return () => window.permutive = backup;
};

const sdkUserIdData = () => ({
  'id5id': {
    'uid': '0',
    'linkType': 0,
    'ext': {
      'abTestingControlGroup': false,
      'linkType': 0,
      'pba': 'EVqgf9vY0fSrsrqJZMOm+Q=='
    }
  },
});

const getUserIdData = () => ({
  'providers': {
    'id5id': {
      'userId': {
        'uid': '0',
        'linkType': 0,
        'ext': {
          'abTestingControlGroup': false,
          'linkType': 0,
          'pba': 'EVqgf9vY0fSrsrqJZMOm+Q=='
        }
      }
    },
    'fooid': {
      'userId': {
        'id': '1'
      }
    }
  }
});
