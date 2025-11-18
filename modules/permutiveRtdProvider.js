/**
 * This module adds permutive provider to the real time data module
 * The {@link module:modules/realTimeData} module is required
 * The module will add custom segment targeting to ad units of specific bidders
 * @module modules/permutiveRtdProvider
 * @requires module:modules/realTimeData
 */

import {getGlobal} from '../src/prebidGlobal.js';
import {submodule} from '../src/hook.js';
import {MODULE_TYPE_RTD} from '../src/activities/modules.js';
import {getStorageManager} from '../src/storageManager.js';
import {deepAccess, deepSetValue, isFn, logError, mergeDeep, isPlainObject, safeJSONParse, prefixLog} from '../src/utils.js';

/**
 * @typedef {import('../modules/rtdModule/index.js').RtdSubmodule} RtdSubmodule
 */

// ============================================================================
// MODULE CONSTANTS AND STORAGE
// ============================================================================

const MODULE_NAME = 'permutive'

const logger = prefixLog('[PermutiveRTD]')

export const PERMUTIVE_SUBMODULE_CONFIG_KEY = 'permutive-prebid-rtd'
export const SDK_CONFIG_KEY = '_ppbconf'
export const PERMUTIVE_STANDARD_KEYWORD = 'p_standard'
export const PERMUTIVE_CUSTOM_COHORTS_KEYWORD = 'permutive'
export const PERMUTIVE_STANDARD_AUD_KEYWORD = 'p_standard_aud'

export const storage = getStorageManager({moduleType: MODULE_TYPE_RTD, moduleName: MODULE_NAME})

let cachedPermutiveModuleConfig = {}
let permutiveSDKInRealTime = false

// ============================================================================
// PUBLIC API - ENTRY POINTS
// ============================================================================

/**
 * Initialize the Permutive RTD module
 * @param {Object} moduleConfig - Module configuration
 * @param {Object} userConsent - User consent object
 * @return {boolean} Always returns true
 */
function init(moduleConfig, userConsent) {
  readPermutiveModuleConfigFromCache()
  return true
}

/**
 * Pull the latest configuration and cohort information and update accordingly.
 * This is the main entry point called by the RTD module.
 * @param {Object} reqBidsConfigObj - Bidder provided config for request
 * @param {Object} moduleConfig - Publisher provided config
 */
export function readAndSetCohorts(reqBidsConfigObj, moduleConfig) {
  const segmentData = getSegments(deepAccess(moduleConfig, 'params.maxSegs'))

  makeSafe(function () {
    // Legacy route with custom parameters
    // ACK policy violation, in process of removing
    setSegments(reqBidsConfigObj, moduleConfig, segmentData)
  });

  makeSafe(function () {
    // Route for bidders supporting ORTB2
    setBidderRtb(reqBidsConfigObj.ortb2Fragments?.bidder, moduleConfig, segmentData)
  })
}

// ============================================================================
// HIGH-LEVEL ORCHESTRATION
// ============================================================================

/**
 * Sets ortb2 config for bidders with Permutive signals
 *
 * This is the main function that orchestrates the dual-mode implementation:
 * 1. Populates cohorts from SDK-driven config (_ppbconf)
 * 2. Populates cohorts from legacy config (localStorage keys)
 * 3. Merges and deduplicates cohorts
 * 4. Applies to ORTB2 structure
 *
 * @param {Object} bidderOrtb2 - The ortb2 object for all bidders
 * @param {Object} moduleConfig - Publisher config for module
 * @param {Object} segmentData - Segment data grouped by bidder or type
 */
export function setBidderRtb (bidderOrtb2, moduleConfig, segmentData) {
  const maxSegs = deepAccess(moduleConfig, 'params.maxSegs')
  const transformationConfigs = deepAccess(moduleConfig, 'params.transformations') || []
  const acBidders = deepAccess(moduleConfig, 'params.acBidders') || []

  // Initialize merged data structures
  const cohortMap = {}
  const metadataMap = {}

  // Populate from both sources (SDK-driven and legacy)
  populateFromSdkConfig(cohortMap, metadataMap)
  populateFromLegacyConfig(cohortMap, metadataMap, moduleConfig, segmentData)

  // Ensure all acBidders have ortb2 entries (even if empty)
  // This ensures ortb2 structure is created for all configured bidders
  acBidders.forEach(bidder => {
    if (!cohortMap[bidder]) {
      cohortMap[bidder] = {}
    }
  })

  // Log what we found
  const sdkConfigCount = readSdkConfig().length
  const hasLegacyConfig = segmentData && (
    (segmentData.ac && segmentData.ac.length > 0) ||
    (segmentData.ssp && segmentData.ssp.cohorts && segmentData.ssp.cohorts.length > 0) ||
    (segmentData.appnexus && segmentData.appnexus.length > 0) ||
    (segmentData.rubicon && segmentData.rubicon.length > 0) ||
    (segmentData.ix && segmentData.ix.length > 0) ||
    (segmentData.gam && segmentData.gam.length > 0)
  )

  if (sdkConfigCount > 0 || hasLegacyConfig) {
    logger.logInfo('Cohort sources', {
      sdkConfigEntries: sdkConfigCount,
      legacyConfigActive: hasLegacyConfig,
      totalBidders: Object.keys(cohortMap).length
    })
  }

  // Apply merged cohorts to ORTB2
  applyMergedCohortsToOrtb2(bidderOrtb2, cohortMap, metadataMap, maxSegs, transformationConfigs)
}

/**
 * Reads cohort data from local storage and returns organized by signal type
 * @param {number} maxSegs - Maximum number of segments per signal type
 * @return {Object} Segment data with AC, SSP, CC signals and topics
 */
export function getSegments(maxSegs) {
  const segments = {
    // AC Signals
    ac:
      makeSafe(() => {
        const standardCohorts =
          makeSafe(() =>
            readSegments('_psegs', [])
              .map(Number)
              .filter((seg) => seg >= 1000000)
              .map(String),
          ) || [];

        const dcrCohorts = makeSafe(() => readSegments('_pcrprs', []).map(String)) || [];

        return [...dcrCohorts, ...standardCohorts].slice(0, maxSegs);
      }) || [],

    // CC Signals (legacy bidder-specific)
    appnexus:
      makeSafe(() => {
        const _papns = readSegments('_papns', []);
        return _papns.map(String).slice(0, maxSegs);
      }) || [],

    rubicon:
      makeSafe(() => {
        const _prubicons = readSegments('_prubicons', []);
        return _prubicons.map(String).slice(0, maxSegs);
      }) || [],

    ix:
      makeSafe(() => {
        const _pindexs = readSegments('_pindexs', []);
        return _pindexs.map(String).slice(0, maxSegs);
      }) || [],

    gam:
      makeSafe(() => {
        const _pdfps = readSegments('_pdfps', []);
        return _pdfps.map(String).slice(0, maxSegs);
      }) || [],

    // SSP Signals
    ssp: makeSafe(() => {
      const _pssps = readSegments('_pssps', {
        cohorts: [],
        ssps: [],
      });

      return {
        cohorts: (makeSafe(() => _pssps.cohorts.map(String)) || []).slice(0, maxSegs),
        ssps: makeSafe(() => _pssps.ssps.map(String)) || [],
      };
    }),

    // Privacy Sandbox Topics
    topics:
      makeSafe(() => {
        const _ppsts = readSegments('_ppsts', {});

        const topics = {};
        for (const [k, value] of Object.entries(_ppsts)) {
          topics[k] = (makeSafe(() => value.map(String)) || []).slice(0, maxSegs);
        }

        return topics;
      }) || {},
  };

  logger.logInfo(`Read segments`, segments)
  return segments;
}

/**
 * Merges segments into existing bidder config in reverse priority order. The highest priority is 1.
 *
 *   1. customModuleConfig <- set by publisher with pbjs.setConfig
 *   2. permutiveRtdConfig <- set by the publisher using the Permutive platform
 *   3. defaultConfig
 *
 * As items with a higher priority will be deeply merged into the previous config, deep merges are performed by
 * reversing the priority order.
 *
 * @param {Object} customModuleConfig - Publisher config for module
 * @return {Object} Deep merges of the default, Permutive and custom config.
 */
export function getModuleConfig(customModuleConfig) {
  // Use the params from Permutive if available, otherwise fallback to the cached value set by Permutive.
  const permutiveModuleConfig = getParamsFromPermutive() || cachedPermutiveModuleConfig

  return mergeDeep({
    waitForIt: false,
    params: {
      maxSegs: 500,
      acBidders: [],
      overwrites: {},
    },
  },
  permutiveModuleConfig,
  customModuleConfig,
  )
}

// ============================================================================
// CORE LOGIC - DUAL MODE IMPLEMENTATION
// ============================================================================

/**
 * Populates cohort map from SDK-driven configuration (_ppbconf)
 *
 * This is the recommended approach: the Permutive SDK writes cohort distribution
 * rules to _ppbconf, specifying which cohorts should go to which bidders and where
 * in the ORTB2 structure they should be placed.
 *
 * @param {Object} cohortMap - Map of bidder -> location -> cohorts
 * @param {Object} metadataMap - Map of bidder -> location -> metadata
 */
function populateFromSdkConfig(cohortMap, metadataMap) {
  const sdkConfig = readSdkConfig()

  if (sdkConfig.length === 0) {
    return
  }

  logger.logInfo('Processing SDK config', { entries: sdkConfig.length })

  sdkConfig.forEach((entry, index) => {
    const { bidders, cohorts, locations } = entry

    bidders.forEach(bidder => {
      if (!cohortMap[bidder]) {
        cohortMap[bidder] = {}
      }
      if (!metadataMap[bidder]) {
        metadataMap[bidder] = {}
      }

      locations.forEach(location => {
        const locationKey = buildLocationKey(location)

        // Initialize Set for this location if needed
        if (!cohortMap[bidder][locationKey]) {
          cohortMap[bidder][locationKey] = new Set()
        }

        // Add cohorts to set (automatic deduplication)
        cohorts.forEach(cohort => {
          cohortMap[bidder][locationKey].add(String(cohort))
        })

        // Store metadata if present (e.g., ext.segtax for Topics)
        if (location.ext) {
          if (!metadataMap[bidder][locationKey]) {
            metadataMap[bidder][locationKey] = {}
          }
          metadataMap[bidder][locationKey].ext = location.ext
          metadataMap[bidder][locationKey].name = location.name
        } else if (location.name) {
          // Store provider name for user.data locations
          if (!metadataMap[bidder][locationKey]) {
            metadataMap[bidder][locationKey] = {}
          }
          metadataMap[bidder][locationKey].name = location.name
        }
      })
    })
  })
}

/**
 * LEGACY CONFIGURATION
 *
 * Populates cohort map from legacy configuration (existing localStorage keys).
 * This handles the original approach to cohort distribution.
 *
 * LOCAL STORAGE KEYS:
 * - _psegs: Raw Permutive segments (filtered to >= 1000000 for Standard Cohorts)
 * - _pcrprs: Data Clean Room (DCR) cohorts
 * - _pssps: { ssps: [...], cohorts: [...] } - SSP signals and bidder codes
 * - _papns, _prubicons, _pindexs, _pdfps: Legacy custom cohorts for specific bidders
 * - _ppsts: Privacy Sandbox Topics by taxonomy version
 *
 * SIGNAL TYPES:
 * - AC Signals: Standard Cohorts + DCR Cohorts → AC bidders (params.acBidders)
 * - SSP Signals: Curation signals → SSP bidders (from _pssps.ssps)
 * - CC Signals: Custom cohorts → legacy bidders only (ix, rubicon, appnexus, gam)
 * - Topics: Privacy Sandbox Topics → All bidders
 *
 * ORTB2 LOCATIONS:
 * - ortb2.user.data "permutive.com": AC/SSP Signals
 * - ortb2.user.data "permutive": CC Signals
 * - ortb2.user.keywords: p_standard, p_standard_aud, permutive
 * - ortb2.user.ext.data: p_standard, permutive
 * - ortb2.site.ext.permutive: p_standard
 *
 * This legacy approach is maintained for backwards compatibility. The recommended approach
 * is SDK-Driven Configuration using the _ppbconf local storage key.
 *
 * @param {Object} cohortMap - Map of bidder -> location -> cohorts
 * @param {Object} metadataMap - Map of bidder -> location -> metadata
 * @param {Object} moduleConfig - Module configuration
 * @param {Object} segmentData - Segment data from getSegments()
 */
function populateFromLegacyConfig(cohortMap, metadataMap, moduleConfig, segmentData) {
  const acBidders = deepAccess(moduleConfig, 'params.acBidders') || []

  const acSignals = segmentData?.ac ?? []
  const sspBidders = segmentData?.ssp?.ssps ?? []
  const sspSignals = segmentData?.ssp?.cohorts ?? []
  const topics = segmentData?.topics ?? {}

  const legacyCcBidders = ['ix', 'rubicon', 'appnexus', 'gam']

  const allBidders = new Set([...acBidders, ...sspBidders, ...legacyCcBidders])

  allBidders.forEach(bidder => {
    const isAcBidder = acBidders.indexOf(bidder) > -1
    const isSspBidder = sspBidders.indexOf(bidder) > -1
    const isLegacyCcBidder = legacyCcBidders.indexOf(bidder) > -1

    // Determine which signals this bidder should receive
    let standardSignals = []
    if (isAcBidder && isSspBidder) {
      // Bidder is in both lists - merge AC + SSP
      standardSignals = [...new Set([...acSignals, ...sspSignals])]
    } else if (isAcBidder) {
      // AC-only bidder
      standardSignals = acSignals
    } else if (isSspBidder) {
      // SSP-only bidder
      standardSignals = sspSignals
    }

    // Add standard signals to permutive.com provider
    if (standardSignals.length > 0) {
      addToLocation(cohortMap, bidder, 'user.data:permutive.com', standardSignals)
      addToLocation(cohortMap, bidder, 'user.keywords:p_standard', standardSignals)
      addToLocation(cohortMap, bidder, 'user.ext.data:p_standard', standardSignals)
      addToLocation(cohortMap, bidder, 'site.ext.permutive:p_standard', standardSignals)

      // Store provider name for user.data
      if (!metadataMap[bidder]) metadataMap[bidder] = {}
      if (!metadataMap[bidder]['user.data:permutive.com']) {
        metadataMap[bidder]['user.data:permutive.com'] = {}
      }
      metadataMap[bidder]['user.data:permutive.com'].name = 'permutive.com'
    }

    // SSP signals also go to p_standard_aud
    if (isSspBidder && sspSignals.length > 0) {
      addToLocation(cohortMap, bidder, 'user.keywords:p_standard_aud', sspSignals)
    }

    // Legacy custom cohorts go to permutive provider (bidder-specific)
    // Note: We always add this entry for all bidders (even when empty) to maintain compatibility
    // with the original implementation, but only legacy bidders will have non-empty segments
    const ccSignals = isLegacyCcBidder ? (segmentData?.[bidder] ?? []) : []

    // Always add to user.data (even if empty)
    addToLocation(cohortMap, bidder, 'user.data:permutive', ccSignals)

    // Store provider name for user.data
    if (!metadataMap[bidder]) metadataMap[bidder] = {}
    if (!metadataMap[bidder]['user.data:permutive']) {
      metadataMap[bidder]['user.data:permutive'] = {}
    }
    metadataMap[bidder]['user.data:permutive'].name = PERMUTIVE_CUSTOM_COHORTS_KEYWORD

    // Add to keywords and ext.data only if there are cohorts
    if (ccSignals.length > 0) {
      addToLocation(cohortMap, bidder, 'user.keywords:permutive', ccSignals)
      addToLocation(cohortMap, bidder, 'user.ext.data:permutive', ccSignals)
    }

    // Topics (for all bidders that have any signals)
    if (isAcBidder || isSspBidder || isLegacyCcBidder) {
      for (const [taxonomy, topicIds] of Object.entries(topics)) {
        if (topicIds && topicIds.length > 0) {
          // Use a unique location key for each taxonomy
          const locationKey = `user.data:permutive.com:${taxonomy}`
          addToLocation(cohortMap, bidder, locationKey, topicIds)

          // Store segtax metadata
          if (!metadataMap[bidder]) metadataMap[bidder] = {}
          if (!metadataMap[bidder][locationKey]) {
            metadataMap[bidder][locationKey] = {}
          }
          metadataMap[bidder][locationKey].ext = { segtax: Number(taxonomy) }
          metadataMap[bidder][locationKey].name = 'permutive.com'
        }
      }
    }
  })
}

/**
 * Applies merged cohorts from cohort map to ORTB2 configs
 *
 * Takes the unified cohort map (populated from both SDK and legacy sources)
 * and applies cohorts to the appropriate ORTB2 locations for each bidder.
 *
 * @param {Object} bidderOrtb2 - Bidder ORTB2 configs
 * @param {Object} cohortMap - Map of bidder -> location -> cohorts
 * @param {Object} metadataMap - Map of bidder -> location -> metadata
 * @param {number} maxSegs - Max segments to include
 * @param {Array} transformationConfigs - Transformation configs
 */
function applyMergedCohortsToOrtb2(bidderOrtb2, cohortMap, metadataMap, maxSegs, transformationConfigs) {
  Object.entries(cohortMap).forEach(([bidder, locations]) => {
    // Create a deep copy to avoid mutating shared references
    const ortbConfig = { ortb2: mergeDeep({}, bidderOrtb2[bidder] || {}) }

    logger.logInfo('Applying cohorts for bidder', { bidder, locations: Object.keys(locations).length })

    Object.entries(locations).forEach(([locationKey, cohortSet]) => {
      // Convert Set to Array and apply maxSegs
      const cohorts = Array.from(cohortSet).slice(0, maxSegs)
      const metadata = metadataMap[bidder]?.[locationKey] || {}

      // Parse location key
      const parts = locationKey.split(':')
      const path = parts[0]

      if (path === 'user.data') {
        // Extract provider name (second part)
        const providerName = parts[1]
        applyToUserData(ortbConfig, providerName, cohorts, metadata, transformationConfigs)
      } else if (path === 'user.keywords') {
        const keywordKey = parts[1]
        applyToUserKeywords(ortbConfig, keywordKey, cohorts)
      } else if (path === 'user.ext.data') {
        const key = parts[1]
        applyToUserExtData(ortbConfig, key, cohorts)
      } else if (path === 'site.ext.permutive') {
        const key = parts[1]
        applyToSiteExtPermutive(ortbConfig, key, cohorts)
      }
    })

    bidderOrtb2[bidder] = ortbConfig.ortb2
  })
}

// ============================================================================
// ORTB2 APPLICATION HELPERS
// ============================================================================

/**
 * Applies cohorts to user.data location
 * @param {Object} ortbConfig - ORTB2 config object
 * @param {string} providerName - Provider name
 * @param {string[]} cohorts - Cohorts to apply
 * @param {Object} metadata - Metadata (ext, etc.)
 * @param {Array} transformationConfigs - Transformation configs (for legacy only)
 */
function applyToUserData(ortbConfig, providerName, cohorts, metadata, transformationConfigs) {
  // For 'permutive' provider, always add entry (even if empty) to maintain compatibility
  // For other providers, skip if no cohorts
  if (cohorts.length === 0 && providerName !== PERMUTIVE_CUSTOM_COHORTS_KEYWORD) return

  const userData = {
    name: providerName,
    segment: cohorts.map(id => ({ id })),
    ...(metadata.ext && { ext: metadata.ext })
  }

  // Apply transformations ONLY for legacy permutive.com provider (without ext.segtax)
  const transformedUserData = (providerName === 'permutive.com' && !metadata.ext && transformationConfigs && cohorts.length > 0)
    ? transformationConfigs
      .filter(({ id }) => ortb2UserDataTransformations.hasOwnProperty(id))
      .map(({ id, config }) => ortb2UserDataTransformations[id](userData, config))
    : []

  const currentUserData = deepAccess(ortbConfig, 'ortb2.user.data') || []

  // Only remove entries that match both name AND ext (to allow multiple entries for topics)
  // If metadata.ext exists (topics), only remove exact matches
  // If no metadata.ext (standard cohorts), remove all entries with that name
  const updatedUserData = currentUserData.filter(el => {
    if (el.name !== providerName) return true
    if (metadata.ext && el.ext) {
      // For topics: only remove if ext matches exactly
      return JSON.stringify(el.ext) !== JSON.stringify(metadata.ext)
    }
    // For non-topics: remove all with same name
    return metadata.ext !== undefined
  }).concat(userData, transformedUserData)

  deepSetValue(ortbConfig, 'ortb2.user.data', updatedUserData)
}

/**
 * Applies cohorts to user.keywords location
 * @param {Object} ortbConfig - ORTB2 config object
 * @param {string} keywordKey - Keyword key (e.g., p_standard)
 * @param {string[]} cohorts - Cohorts to apply
 */
function applyToUserKeywords(ortbConfig, keywordKey, cohorts) {
  if (cohorts.length === 0) return

  const currentKeywords = deepAccess(ortbConfig, 'ortb2.user.keywords') || ''
  const existingKeywords = currentKeywords.split(',').map(kv => kv.trim()).filter(Boolean)

  const newKeywords = cohorts.map(id => `${keywordKey}=${id}`)

  const keywords = Array.from(new Set([...existingKeywords, ...newKeywords]))
    .filter(Boolean)
    .join(',')

  deepSetValue(ortbConfig, 'ortb2.user.keywords', keywords)
}

/**
 * Applies cohorts to user.ext.data location
 * @param {Object} ortbConfig - ORTB2 config object
 * @param {string} key - Key name
 * @param {string[]} cohorts - Cohorts to apply
 */
function applyToUserExtData(ortbConfig, key, cohorts) {
  if (cohorts.length === 0) return
  deepSetValue(ortbConfig, `ortb2.user.ext.data.${key}`, cohorts)
}

/**
 * Applies cohorts to site.ext.permutive location
 * @param {Object} ortbConfig - ORTB2 config object
 * @param {string} key - Key name
 * @param {string[]} cohorts - Cohorts to apply
 */
function applyToSiteExtPermutive(ortbConfig, key, cohorts) {
  if (cohorts.length === 0) return
  deepSetValue(ortbConfig, `ortb2.site.ext.permutive.${key}`, cohorts)
}

// ============================================================================
// SDK CONFIG UTILITIES
// ============================================================================

/**
 * Reads and validates SDK-driven configuration from _ppbconf
 * @return {Array} Array of validated configuration entries
 */
function readSdkConfig() {
  const config = readSegments(SDK_CONFIG_KEY, null)
  if (!config || !Array.isArray(config)) {
    return []
  }
  return config.filter(entry => validateSdkConfigEntry(entry))
}

/**
 * Validates a single SDK config entry
 * @param {Object} entry - Config entry to validate
 * @return {boolean} True if valid
 */
function validateSdkConfigEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    logger.logWarn('Invalid SDK config entry: not an object', entry)
    return false
  }

  if (!Array.isArray(entry.bidders) || entry.bidders.length === 0) {
    logger.logWarn('Invalid SDK config entry: bidders must be non-empty array', entry)
    return false
  }

  if (!Array.isArray(entry.cohorts)) {
    logger.logWarn('Invalid SDK config entry: cohorts must be array', entry)
    return false
  }

  if (!Array.isArray(entry.locations) || entry.locations.length === 0) {
    logger.logWarn('Invalid SDK config entry: locations must be non-empty array', entry)
    return false
  }

  // Validate each location
  for (const location of entry.locations) {
    if (!location || typeof location !== 'object') {
      logger.logWarn('Invalid SDK config location: not an object', location)
      return false
    }

    if (!location.path) {
      logger.logWarn('Invalid SDK config location: missing path', location)
      return false
    }

    // Validate path-specific requirements
    if (location.path === 'user.data') {
      if (!location.name) {
        logger.logWarn('Invalid SDK config location: user.data requires name', location)
        return false
      }
    } else if (['user.ext.data', 'user.keywords', 'site.ext.permutive'].includes(location.path)) {
      if (!location.key) {
        logger.logWarn(`Invalid SDK config location: ${location.path} requires key`, location)
        return false
      }
    } else {
      logger.logWarn('Invalid SDK config location: unknown path', location)
      return false
    }
  }

  return true
}

/**
 * Builds a unique location key for the cohort map
 * @param {Object} location - Location config object
 * @return {string} Location key
 */
function buildLocationKey(location) {
  if (location.path === 'user.data') {
    return `user.data:${location.name}`
  }
  return `${location.path}:${location.key}`
}

// ============================================================================
// SHARED UTILITIES
// ============================================================================

/**
 * Helper to add cohorts to a location in the cohort map
 * @param {Object} cohortMap - Cohort map
 * @param {string} bidder - Bidder code
 * @param {string} locationKey - Location key
 * @param {string[]} cohorts - Cohorts to add
 */
function addToLocation(cohortMap, bidder, locationKey, cohorts) {
  if (!cohortMap[bidder]) {
    cohortMap[bidder] = {}
  }
  if (!cohortMap[bidder][locationKey]) {
    cohortMap[bidder][locationKey] = new Set()
  }
  cohorts.forEach(cohort => {
    cohortMap[bidder][locationKey].add(String(cohort))
  })
}

/**
 * Gets an array of segment IDs from LocalStorage
 * or return the default value provided.
 * @template A
 * @param {string} key
 * @param {A} defaultValue
 * @return {A}
 */
function readSegments (key, defaultValue) {
  try {
    return JSON.parse(storage.getDataFromLocalStorage(key)) || defaultValue
  } catch (e) {
    return defaultValue
  }
}

/**
 * Catch and log errors
 * @param {function} fn - Function to safely evaluate
 */
function makeSafe (fn) {
  try {
    return fn()
  } catch (e) {
    logError(e)
  }
}

/**
 * Check whether ac is enabled for bidder
 * @param {Object} moduleConfig - Module configuration
 * @param {string} bidder - Bidder name
 * @return {boolean}
 */
export function isAcEnabled (moduleConfig, bidder) {
  const acBidders = deepAccess(moduleConfig, 'params.acBidders') || []
  return acBidders.includes(bidder)
}

/**
 * Check whether Permutive is on page
 * @return {boolean}
 */
export function isPermutiveOnPage () {
  return typeof window.permutive !== 'undefined' && typeof window.permutive.ready === 'function'
}

/**
 * Get custom bidder function from module config
 * @param {Object} moduleConfig - Module configuration
 * @param {string} bidder - Bidder name
 * @return {function|null}
 */
function getCustomBidderFn (moduleConfig, bidder) {
  const overwriteFn = deepAccess(moduleConfig, `params.overwrites.${bidder}`)

  if (overwriteFn && isFn(overwriteFn)) {
    return overwriteFn
  } else {
    return null
  }
}

// ============================================================================
// TRANSFORMATION UTILITIES
// ============================================================================

const unknownIabSegmentId = '_unknown_'

/**
 * Functions to apply to ORTB2 `user.data` objects.
 * Each function should return a new object containing `name`, (optional) `ext` and `segment`
 * properties. The result of each transformation defined here will be appended to the array
 * under `user.data` in the bid request.
 */
const ortb2UserDataTransformations = {
  iab: (userData, config) => ({
    name: userData.name,
    ext: { segtax: config.segtax },
    segment: (userData.segment || [])
      .map(segment => ({ id: iabSegmentId(segment.id, config.iabIds) }))
      .filter(segment => segment.id !== unknownIabSegmentId)
  })
}

/**
 * Transform a Permutive segment ID into an IAB audience taxonomy ID.
 * @param {string} permutiveSegmentId
 * @param {Object} iabIds object of mappings between Permutive and IAB segment IDs (key: permutive ID, value: IAB ID)
 * @return {string} IAB audience taxonomy ID associated with the Permutive segment ID
 */
function iabSegmentId(permutiveSegmentId, iabIds) {
  return iabIds[permutiveSegmentId] || unknownIabSegmentId
}

// ============================================================================
// CONFIG MANAGEMENT UTILITIES
// ============================================================================

/**
 * Lift params into params object wrapper
 * @param {Object} params - Parameters
 * @return {Object}
 */
function liftIntoParams(params) {
  return isPlainObject(params) ? { params } : {}
}

/**
 * Access the submodules RTD params that are cached to LocalStorage by the Permutive SDK. This lets the RTD submodule
 * apply publisher defined params set in the Permutive platform, so they may still be applied if the Permutive SDK has
 * not initialised before this submodule is initialised.
 */
function readPermutiveModuleConfigFromCache() {
  const params = safeJSONParse(storage.getDataFromLocalStorage(PERMUTIVE_SUBMODULE_CONFIG_KEY))
  cachedPermutiveModuleConfig = liftIntoParams(params)
  return cachedPermutiveModuleConfig
}

/**
 * Access the submodules RTD params attached to the Permutive SDK.
 *
 * @return The Permutive config available by the Permutive SDK or null if the operation errors.
 */
function getParamsFromPermutive() {
  try {
    return liftIntoParams(window.permutive.addons.prebid.getPermutiveRtdConfig())
  } catch (e) {
    return null
  }
}

// ============================================================================
// LEGACY FUNCTIONS
// ============================================================================

/**
 * Set segments on bid request object (legacy custom parameters route)
 * @param {Object} reqBidsConfigObj - Bid request object
 * @param {Object} moduleConfig - Module configuration
 * @param {Object} segmentData - Segment object
 */
function setSegments (reqBidsConfigObj, moduleConfig, segmentData) {
  const adUnits = (reqBidsConfigObj && reqBidsConfigObj.adUnits) || getGlobal().adUnits
  const utils = { deepSetValue, deepAccess, isFn, mergeDeep }
  const aliasMap = {
    appnexusAst: 'appnexus'
  }

  if (!adUnits) {
    return
  }

  adUnits.forEach(adUnit => {
    adUnit.bids.forEach(bid => {
      let { bidder } = bid
      if (typeof aliasMap[bidder] !== 'undefined') {
        bidder = aliasMap[bidder]
      }
      const acEnabled = isAcEnabled(moduleConfig, bidder)
      const customFn = getCustomBidderFn(moduleConfig, bidder)

      if (customFn) {
        // For backwards compatibility we pass an identity function to any custom bidder function set by a publisher
        const bidIdentity = (bid) => bid
        customFn(bid, segmentData, acEnabled, utils, bidIdentity)
      }
    })
  })
}

// ============================================================================
// MODULE REGISTRATION
// ============================================================================

/** @type {RtdSubmodule} */
export const permutiveSubmodule = {
  name: MODULE_NAME,
  getBidRequestData: function (reqBidsConfigObj, callback, customModuleConfig) {
    const completeBidRequestData = () => {
      logger.logInfo(`Request data updated`)
      callback()
    }

    const moduleConfig = getModuleConfig(customModuleConfig)

    readAndSetCohorts(reqBidsConfigObj, moduleConfig)

    makeSafe(function () {
      if (permutiveSDKInRealTime || !(moduleConfig.waitForIt && isPermutiveOnPage())) {
        return completeBidRequestData()
      }

      window.permutive.ready(function () {
        logger.logInfo(`SDK is realtime, updating cohorts`)
        permutiveSDKInRealTime = true
        readAndSetCohorts(reqBidsConfigObj, getModuleConfig(customModuleConfig))
        completeBidRequestData()
      }, 'realtime')

      logger.logInfo(`Registered cohort update when SDK is realtime`)
    })
  },
  init: init
}

submodule('realTimeData', permutiveSubmodule)
