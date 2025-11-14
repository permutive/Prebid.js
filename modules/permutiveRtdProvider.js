/**
 * This module adds permutive provider to the real time data module
 * The {@link module:modules/realTimeData} module is required
 * The module will add custom segment targeting to ad units of specific bidders
 * @module modules/permutiveRtdProvider
 * @requires module:modules/realTimeData
 */

/**
 * LOCAL STORAGE KEYS READ BY THIS MODULE:
 *
 * Cohort Data:
 * - _psegs: Raw Permutive segments (filtered to >= 1000000 for Standard Cohorts)
 * - _pcrprs: Data Clean Room (DCR) cohorts from privacy-enhanced partnerships
 * - _pssps: { ssps: ['bidder1', ...], cohorts: [...] } - SSP signals and recipient SSP bidder codes
 * - _papns: AppNexus/Xandr-specific custom cohorts
 * - _prubicons: Rubicon/Magnite-specific custom cohorts
 * - _pindexs: Index Exchange-specific custom cohorts
 * - _pdfps: Google Ad Manager-specific custom cohorts
 * - _ppsts: Privacy Sandbox Topics, keyed by IAB taxonomy version (e.g., { '600': [...], '601': [...] })
 *
 * Configuration:
 * - permutive-prebid-rtd: Module configuration set by Permutive SDK
 *
 * SIGNAL TYPES & DISTRIBUTION:
 *
 * AC Signals (Standard Cohorts + DCR Cohorts):
 *   - Sent to: AC Bidders (configured via params.acBidders)
 *   - Source: _psegs (>= 1000000) + _pcrprs
 *   - Cohort types: Standard Cohorts, DCR Cohorts
 *
 * SSP Signals (Curation Signals):
 *   - Sent to: SSP Bidders (list provided in _pssps.ssps)
 *   - Source: _pssps.cohorts
 *   - Cohort types: Curated mix of DCR, Standard, and Curated cohorts
 *
 * Bidders that are BOTH AC and SSP:
 *   - Receive: AC Signals + SSP Signals (merged and deduped)
 *
 * Custom Cohorts (bidder-specific):
 *   - Sent to: Specific bidder only
 *   - Source: Bidder-specific keys (_papns, _prubicons, _pindexs, _pdfps)
 *
 * ORTB2 LOCATIONS & SIGNAL MAPPING:
 *
 * ortb2.user.data[] (array of provider objects):
 *   - Provider "permutive.com": AC Signals or AC+SSP Signals merged
 *   - Provider "permutive": Bidder-specific custom cohorts
 *   - Provider "permutive.com" with segtax: Privacy Sandbox Topics (per taxonomy)
 *
 * ortb2.user.keywords (comma-separated key=value pairs):
 *   - p_standard=<id>: AC Signals or AC+SSP Signals merged
 *   - p_standard_aud=<id>: SSP Signals only
 *   - permutive=<id>: Bidder-specific custom cohorts
 *
 * ortb2.user.ext.data (first-party data extensions):
 *   - p_standard: AC Signals or AC+SSP Signals merged
 *   - permutive: Bidder-specific custom cohorts
 *
 * ortb2.site.ext.permutive (site-level extensions):
 *   - p_standard: AC Signals or AC+SSP Signals merged
 */

import {getGlobal} from '../src/prebidGlobal.js';
import {submodule} from '../src/hook.js';
import {getStorageManager} from '../src/storageManager.js';
import {deepAccess, deepSetValue, isFn, logError, mergeDeep, isPlainObject, safeJSONParse, prefixLog} from '../src/utils.js';

import {MODULE_TYPE_RTD} from '../src/activities/modules.js';

/**
 * @typedef {import('../modules/rtdModule/index.js').RtdSubmodule} RtdSubmodule
 */

const MODULE_NAME = 'permutive'

const logger = prefixLog('[PermutiveRTD]')

export const PERMUTIVE_SUBMODULE_CONFIG_KEY = 'permutive-prebid-rtd'
export const PERMUTIVE_STANDARD_KEYWORD = 'p_standard'
export const PERMUTIVE_CUSTOM_COHORTS_KEYWORD = 'permutive'
export const PERMUTIVE_STANDARD_AUD_KEYWORD = 'p_standard_aud'

export const storage = getStorageManager({moduleType: MODULE_TYPE_RTD, moduleName: MODULE_NAME})

function init(moduleConfig, userConsent) {
  readPermutiveModuleConfigFromCache()

  return true
}

function liftIntoParams(params) {
  return isPlainObject(params) ? { params } : {}
}

let cachedPermutiveModuleConfig = {}

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

/**
 * Sets ortb2 config for ac bidders
 * @param {Object} bidderOrtb2 - The ortb2 object for the all bidders
 * @param {Object} moduleConfig - Publisher config for module
 * @param {Object} segmentData - Segment data grouped by bidder or type
 */
export function setBidderRtb (bidderOrtb2, moduleConfig, segmentData) {
  const acBidders = deepAccess(moduleConfig, 'params.acBidders')
  const maxSegs = deepAccess(moduleConfig, 'params.maxSegs')
  const transformationConfigs = deepAccess(moduleConfig, 'params.transformations') || []

  // AC Signals: Standard Cohorts + DCR Cohorts
  const acSignals = segmentData?.ac ?? []

  // SSP Signals: Curation signals (curated mix of DCR, Standard, and Curated cohorts)
  const sspBidderCodes = segmentData?.ssp?.ssps ?? []
  const sspSignals = segmentData?.ssp?.cohorts ?? []

  const topics = segmentData?.topics ?? {}

  // Process all bidders (union of AC bidders and SSP bidders)
  const bidders = new Set([...acBidders, ...sspBidderCodes])
  bidders.forEach(function (bidder) {
    const currConfig = { ortb2: bidderOrtb2[bidder] || {} }

    // Determine which signals this bidder should receive
    const isAcBidder = acBidders.indexOf(bidder) > -1
    const isSspBidder = sspBidderCodes.indexOf(bidder) > -1

    let signalsForBidder = []

    if (isAcBidder) {
      // AC Bidders receive AC Signals (Standard + DCR cohorts)
      signalsForBidder = acSignals
    }

    if (isSspBidder) {
      // SSP Bidders receive SSP Signals (may also include AC Signals if bidder is both AC and SSP)
      signalsForBidder = [...new Set([...signalsForBidder, ...sspSignals])].slice(0, maxSegs)
    }

    const nextConfig = updateOrtbConfig(
      bidder,
      currConfig,
      signalsForBidder,     // Merged signals for this bidder (AC only, SSP only, or AC+SSP)
      sspSignals,           // SSP Signals (for p_standard_aud keyword)
      topics,
      transformationConfigs,
      segmentData
    )
    bidderOrtb2[bidder] = nextConfig.ortb2
  })
}

/**
 * Updates ORTB2 config for a bidder with Permutive cohorts across multiple locations:
 *
 * ortb2.user.data[] providers:
 * - "permutive.com": Contains AC Signals (Standard + DCR cohorts) or AC+SSP Signals merged
 * - "permutive": Contains bidder-specific custom cohorts
 * - "permutive.com" with segtax: Contains Privacy Sandbox Topics (per taxonomy version)
 *
 * ortb2.user.keywords:
 * - p_standard=<id>: AC Signals or AC+SSP Signals merged
 * - p_standard_aud=<id>: SSP Signals only (curation signals)
 * - permutive=<id>: Bidder-specific custom cohorts
 *
 * ortb2.user.ext.data:
 * - p_standard: AC Signals or AC+SSP Signals merged
 * - permutive: Bidder-specific custom cohorts
 *
 * ortb2.site.ext.permutive:
 * - p_standard: AC Signals or AC+SSP Signals merged
 *
 * @param {string} bidder - The bidder identifier
 * @param {Object} currConfig - Current bidder config
 * @param {string[]} mergedSignalIds - Combined signals for this bidder (AC, SSP, or AC+SSP merged)
 * @param {string[]} sspSignalIds - SSP Signals (curation signal IDs, used only for p_standard_aud keywords)
 * @param {Object} topics - Privacy Sandbox Topics, keyed by IAB taxonomy version (600, 601, etc.)
 * @param {Object[]} transformationConfigs - Array of transformation configs (e.g., IAB taxonomy mappings)
 * @param {Object} segmentData - All segment data (includes bidder-specific custom cohorts)
 * @return {Object} Updated ortb2 config object
 */
function updateOrtbConfig(bidder, currConfig, mergedSignalIds, sspSignalIds, topics, transformationConfigs, segmentData) {
  logger.logInfo(`Current ortb2 config`, { bidder, config: currConfig })

  // Get bidder-specific custom cohorts (e.g., _papns for AppNexus, _prubicons for Rubicon)
  const bidderCustomCohorts = deepAccess(segmentData, bidder) || []

  const name = 'permutive.com'

  // === ORTB2.USER.DATA[] SETUP ===

  // 1. "permutive.com" provider: AC Signals or AC+SSP Signals merged
  //    Contains: Standard Cohorts + DCR Cohorts (+ Curation Signals if bidder is both AC and SSP)
  const permutiveUserData = {
    name,
    segment: mergedSignalIds.map(segmentId => ({ id: segmentId })),
  }

  // 2. Optional IAB taxonomy transformations on AC/SSP signals
  const transformedUserData = transformationConfigs
    .filter(({ id }) => ortb2UserDataTransformations.hasOwnProperty(id))
    .map(({ id, config }) => ortb2UserDataTransformations[id](permutiveUserData, config))

  // 3. "permutive" provider: Bidder-specific custom cohorts
  //    Contains: Custom cohorts from bidder-specific local storage keys
  const customCohortsUserData = {
    name: PERMUTIVE_CUSTOM_COHORTS_KEYWORD,
    segment: bidderCustomCohorts.map(cohortID => ({ id: cohortID })),
  }

  // 4. "permutive.com" provider with segtax: Privacy Sandbox Topics (one entry per taxonomy version)
  //    Contains: Google Topics API signals
  const topicsUserData = []
  for (const [k, value] of Object.entries(topics)) {
    topicsUserData.push({
      name,
      ext: {
        segtax: Number(k)
      },
      segment: value.map(topic => ({ id: topic.toString() })),
    })
  }

  // Merge all user.data[] entries, removing old Permutive entries first
  const ortbConfig = mergeDeep({}, currConfig)
  const currentUserData = deepAccess(ortbConfig, 'ortb2.user.data') || []
  const updatedUserData = currentUserData
    .filter(el => el.name !== permutiveUserData.name && el.name !== customCohortsUserData.name)
    .concat(permutiveUserData, transformedUserData, customCohortsUserData)
    .concat(topicsUserData)

  logger.logInfo(`Updating ortb2.user.data`, { bidder, user_data: updatedUserData })
  deepSetValue(ortbConfig, 'ortb2.user.data', updatedUserData)

  // === ORTB2.USER.KEYWORDS SETUP ===

  const currentKeywords = deepAccess(ortbConfig, 'ortb2.user.keywords')
  const keywordGroups = {
    [PERMUTIVE_STANDARD_KEYWORD]: mergedSignalIds,          // p_standard: AC Signals or AC+SSP Signals merged
    [PERMUTIVE_STANDARD_AUD_KEYWORD]: sspSignalIds,         // p_standard_aud: SSP Signals only
    [PERMUTIVE_CUSTOM_COHORTS_KEYWORD]: bidderCustomCohorts, // permutive: Bidder-specific custom cohorts
  }

  // Transform groups of key-values into a single array of strings
  // i.e { permutive: ['1', '2'], p_standard: ['3', '4'] } => ['permutive=1', 'permutive=2', 'p_standard=3', 'p_standard=4']
  const transformedKeywordGroups = Object.entries(keywordGroups)
    .flatMap(([keyword, ids]) => ids.map(id => `${keyword}=${id}`))

  const keywords = Array.from(new Set([
    ...(currentKeywords || '').split(',').map(kv => kv.trim()),
    ...transformedKeywordGroups
  ]))
    .filter(Boolean)
    .join(',')

  logger.logInfo(`Updating ortb2.user.keywords`, {
    bidder,
    keywords,
  })
  deepSetValue(ortbConfig, 'ortb2.user.keywords', keywords)

  // === ORTB2.USER.EXT.DATA SETUP ===

  // Set p_standard: AC Signals or AC+SSP Signals merged
  if (mergedSignalIds.length > 0) {
    deepSetValue(ortbConfig, `ortb2.user.ext.data.${PERMUTIVE_STANDARD_KEYWORD}`, mergedSignalIds)
    logger.logInfo(`Extending ortb2.user.ext.data with "${PERMUTIVE_STANDARD_KEYWORD}"`, mergedSignalIds)
  }

  // Set permutive: Bidder-specific custom cohorts
  if (bidderCustomCohorts.length > 0) {
    deepSetValue(ortbConfig, `ortb2.user.ext.data.${PERMUTIVE_CUSTOM_COHORTS_KEYWORD}`, bidderCustomCohorts.map(String))
    logger.logInfo(`Extending ortb2.user.ext.data with "${PERMUTIVE_CUSTOM_COHORTS_KEYWORD}"`, bidderCustomCohorts)
  }

  // === ORTB2.SITE.EXT.PERMUTIVE SETUP ===

  // Set p_standard: AC Signals or AC+SSP Signals merged at site level
  if (mergedSignalIds.length > 0) {
    deepSetValue(ortbConfig, `ortb2.site.ext.permutive.${PERMUTIVE_STANDARD_KEYWORD}`, mergedSignalIds)
    logger.logInfo(`Extending ortb2.site.ext.permutive with "${PERMUTIVE_STANDARD_KEYWORD}"`, mergedSignalIds)
  }

  logger.logInfo(`Updated ortb2 config`, { bidder, config: ortbConfig })
  return ortbConfig
}

/**
 * Set segments on bid request object
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

function getCustomBidderFn (moduleConfig, bidder) {
  const overwriteFn = deepAccess(moduleConfig, `params.overwrites.${bidder}`)

  if (overwriteFn && isFn(overwriteFn)) {
    return overwriteFn
  } else {
    return null
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
 * Reads cohort data from local storage keys written by the Permutive SDK.
 * Returns segment data organized by signal type (AC, SSP) and bidder-specific custom cohorts.
 *
 * @param {number} maxSegs - Maximum number of segments per cohort type
 * @return {Object} Segment data with AC signals, SSP signals, custom cohorts, and topics
 */
export function getSegments(maxSegs) {
  const segments = {
    // AC Signals: Standard Cohorts + DCR Cohorts
    // Sent to AC Bidders via p_standard keyword and ortb2.user.data "permutive.com" provider
    ac:
      makeSafe(() => {
        // Standard Cohorts: Permutive's core audience segments (_psegs >= 1000000)
        const standardCohorts =
          makeSafe(() =>
            readSegments('_psegs', [])
              .map(Number)
              .filter((seg) => seg >= 1000000)  // Filter to only Standard Cohorts
              .map(String),
          ) || [];

        // DCR Cohorts: Data Clean Room cohorts from privacy-enhanced partnerships (_pcrprs)
        const dcrCohorts = makeSafe(() => readSegments('_pcrprs', []).map(String)) || [];

        return [...dcrCohorts, ...standardCohorts];
      }) || [],

    // Bidder-specific custom cohorts (sent via "permutive" provider in ortb2.user.data)

    // Index Exchange custom cohorts (_pindexs)
    ix:
      makeSafe(() => {
        const _pindexs = readSegments('_pindexs', []);
        return _pindexs.map(String);
      }) || [],

    // Rubicon/Magnite custom cohorts (_prubicons)
    rubicon:
      makeSafe(() => {
        const _prubicons = readSegments('_prubicons', []);
        return _prubicons.map(String);
      }) || [],

    // AppNexus/Xandr custom cohorts (_papns)
    appnexus:
      makeSafe(() => {
        const _papns = readSegments('_papns', []);
        return _papns.map(String);
      }) || [],

    // Google Ad Manager custom cohorts (_pdfps)
    gam:
      makeSafe(() => {
        const _pdfps = readSegments('_pdfps', []);
        return _pdfps.map(String);
      }) || [],

    // SSP Signals: Curation signals (curated mix of DCR, Standard, and Curated cohorts)
    // Sent to SSP Bidders via p_standard_aud keyword
    // Includes both the signal IDs and the list of SSP bidder codes that should receive them
    ssp: makeSafe(() => {
      const _pssps = readSegments('_pssps', {
        cohorts: [],  // SSP Signal IDs (curation signals)
        ssps: [],     // SSP bidder codes
      });

      return {
        cohorts: makeSafe(() => _pssps.cohorts.map(String)) || [],
        ssps: makeSafe(() => _pssps.ssps.map(String)) || [],
      };
    }),

    // Privacy Sandbox Topics: Google Topics API signals, keyed by IAB taxonomy version
    // Sent to all bidders via "permutive.com" provider with segtax in ortb2.user.data
    topics:
      makeSafe(() => {
        const _ppsts = readSegments('_ppsts', {});

        const topics = {};
        for (const [k, value] of Object.entries(_ppsts)) {
          topics[k] = makeSafe(() => value.map(String)) || [];
        }

        return topics;
      }) || {},
  };

  for (const bidder in segments) {
    if (bidder === 'ssp') {
      if (segments[bidder].cohorts && Array.isArray(segments[bidder].cohorts)) {
        segments[bidder].cohorts = segments[bidder].cohorts.slice(0, maxSegs)
      }
    } else if (bidder === 'topics') {
      for (const taxonomy in segments[bidder]) {
        segments[bidder][taxonomy] = segments[bidder][taxonomy].slice(0, maxSegs)
      }
    } else {
      segments[bidder] = segments[bidder].slice(0, maxSegs)
    }
  }

  logger.logInfo(`Read segments`, segments)
  return segments;
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

const unknownIabSegmentId = '_unknown_'

/**
 * Functions to apply to ORT2B2 `user.data` objects.
 * Each function should return an a new object containing a `name`, (optional) `ext` and `segment`
 * properties. The result of the each transformation defined here will be appended to the array
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

/**
 * Pull the latest configuration and cohort information and update accordingly.
 *
 * @param reqBidsConfigObj - Bidder provided config for request
 * @param moduleConfig - Publisher provided config
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

let permutiveSDKInRealTime = false

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
