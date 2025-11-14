/**
 * This module adds permutive provider to the real time data module
 * The {@link module:modules/realTimeData} module is required
 * The module will add custom segment targeting to ad units of specific bidders
 * @module modules/permutiveRtdProvider
 * @requires module:modules/realTimeData
 */

/**
 * LOCAL STORAGE KEYS:
 * - _psegs: Raw Permutive segments (filtered to >= 1000000 for Standard Cohorts)
 * - _pcrprs: Data Clean Room (DCR) cohorts
 * - _pssps: { ssps: [...], cohorts: [...] } - SSP signals and bidder codes
 * - _pprebid: Custom cohorts
 * - _papns, _prubicons, _pindexs, _pdfps: Legacy custom cohorts (merged with _pprebid)
 * - _ppsts: Privacy Sandbox Topics by taxonomy version
 *
 * SIGNAL TYPES:
 * - AC Signals: Standard Cohorts + DCR Cohorts → AC bidders (params.acBidders)
 * - SSP Signals: Curation signals → SSP bidders (from _pssps.ssps)
 * - CC Signals: Custom cohorts → CC bidders (params.ccBidders) + legacy bidders (ix, rubicon, appnexus, gam)
 * - Topics: Privacy Sandbox Topics → All bidders
 *
 * ORTB2 LOCATIONS:
 * - ortb2.user.data "permutive.com": AC/SSP Signals
 * - ortb2.user.data "permutive": CC Signals
 * - ortb2.user.keywords: p_standard, p_standard_aud, permutive
 * - ortb2.user.ext.data: p_standard, permutive
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
      ccBidders: [],
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

  const acSignals = segmentData?.ac ?? []
  const sspBidders = segmentData?.ssp?.ssps ?? []
  const sspSignals = segmentData?.ssp?.cohorts ?? []
  const topics = segmentData?.topics ?? {}
  const customCohorts = segmentData?.customCohorts ?? []

  const ccBidders = deepAccess(moduleConfig, 'params.ccBidders') || []
  const legacyCcBidders = ['ix', 'rubicon', 'appnexus', 'gam']

  const bidders = new Set([...acBidders, ...sspBidders, ...ccBidders, ...legacyCcBidders])

  bidders.forEach(function (bidder) {
    const currConfig = { ortb2: bidderOrtb2[bidder] || {} }

    const isAcBidder = acBidders.indexOf(bidder) > -1
    const isSspBidder = sspBidders.indexOf(bidder) > -1
    const isCcBidder = ccBidders.indexOf(bidder) > -1 || legacyCcBidders.indexOf(bidder) > -1

    const nextConfig = updateOrtbConfig(
      bidder,
      currConfig,
      isAcBidder ? acSignals : [],
      isSspBidder ? sspSignals : [],
      isCcBidder ? customCohorts : [],
      topics,
      transformationConfigs,
      maxSegs
    )
    bidderOrtb2[bidder] = nextConfig.ortb2
  })
}

/**
 * Updates ORTB2 config for a bidder with Permutive signals
 * @param {string} bidder
 * @param {Object} currConfig
 * @param {string[]} acSignals - AC Signals for this bidder
 * @param {string[]} sspSignals - SSP Signals for this bidder
 * @param {string[]} ccSignals - CC Signals for this bidder
 * @param {Object} topics - Privacy Sandbox Topics
 * @param {Object[]} transformationConfigs - IAB taxonomy transformations
 * @param {number} maxSegs - Maximum segments per signal type
 * @return {Object} Updated ortb2 config
 */
function updateOrtbConfig(bidder, currConfig, acSignals, sspSignals, ccSignals, topics, transformationConfigs, maxSegs) {
  logger.logInfo(`Current ortb2 config`, { bidder, config: currConfig })

  // Merge AC + SSP signals for p_standard and permutive.com provider
  const mergedSignals = [...new Set([...acSignals, ...sspSignals])].slice(0, maxSegs)

  const name = 'permutive.com'

  const permutiveUserData = {
    name,
    segment: mergedSignals.map(segmentId => ({ id: segmentId })),
  }

  const transformedUserData = transformationConfigs
    .filter(({ id }) => ortb2UserDataTransformations.hasOwnProperty(id))
    .map(({ id, config }) => ortb2UserDataTransformations[id](permutiveUserData, config))

  const ccUserData = {
    name: PERMUTIVE_CUSTOM_COHORTS_KEYWORD,
    segment: ccSignals.map(cohortID => ({ id: cohortID })),
  }

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

  const ortbConfig = mergeDeep({}, currConfig)
  const currentUserData = deepAccess(ortbConfig, 'ortb2.user.data') || []
  const updatedUserData = currentUserData
    .filter(el => el.name !== permutiveUserData.name && el.name !== ccUserData.name)
    .concat(permutiveUserData, transformedUserData, ccUserData)
    .concat(topicsUserData)

  logger.logInfo(`Updating ortb2.user.data`, { bidder, user_data: updatedUserData })
  deepSetValue(ortbConfig, 'ortb2.user.data', updatedUserData)

  const currentKeywords = deepAccess(ortbConfig, 'ortb2.user.keywords')
  const keywordGroups = {
    [PERMUTIVE_STANDARD_KEYWORD]: mergedSignals,
    [PERMUTIVE_STANDARD_AUD_KEYWORD]: sspSignals,
    [PERMUTIVE_CUSTOM_COHORTS_KEYWORD]: ccSignals,
  }

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

  if (mergedSignals.length > 0) {
    deepSetValue(ortbConfig, `ortb2.user.ext.data.${PERMUTIVE_STANDARD_KEYWORD}`, mergedSignals)
    logger.logInfo(`Extending ortb2.user.ext.data with "${PERMUTIVE_STANDARD_KEYWORD}"`, mergedSignals)
  }

  if (ccSignals.length > 0) {
    deepSetValue(ortbConfig, `ortb2.user.ext.data.${PERMUTIVE_CUSTOM_COHORTS_KEYWORD}`, ccSignals.map(String))
    logger.logInfo(`Extending ortb2.user.ext.data with "${PERMUTIVE_CUSTOM_COHORTS_KEYWORD}"`, ccSignals)
  }

  if (mergedSignals.length > 0) {
    deepSetValue(ortbConfig, `ortb2.site.ext.permutive.${PERMUTIVE_STANDARD_KEYWORD}`, mergedSignals)
    logger.logInfo(`Extending ortb2.site.ext.permutive with "${PERMUTIVE_STANDARD_KEYWORD}"`, mergedSignals)
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

    // CC Signals
    customCohorts:
      makeSafe(() => {
        const pprebid = makeSafe(() =>
          readSegments('_pprebid', []).map(String)
        ) || [];

        const legacyAppnexus = makeSafe(() => readSegments('_papns', []).map(String)) || [];
        const legacyRubicon = makeSafe(() => readSegments('_prubicons', []).map(String)) || [];
        const legacyIndex = makeSafe(() => readSegments('_pindexs', []).map(String)) || [];
        const legacyGam = makeSafe(() => readSegments('_pdfps', []).map(String)) || [];

        return [...new Set([
          ...pprebid,
          ...legacyAppnexus,
          ...legacyRubicon,
          ...legacyIndex,
          ...legacyGam
        ])].slice(0, maxSegs);
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
