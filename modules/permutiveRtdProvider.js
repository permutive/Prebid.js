/**
 * This module adds permutive provider to the real time data module
 * The {@link module:modules/realTimeData} module is required
 * The module will add custom segment targeting to ad units of specific bidders
 * @module modules/permutiveRtdProvider
 * @requires module:modules/realTimeData
 */
import {getGlobal} from '../src/prebidGlobal.js';
import {submodule} from '../src/hook.js';
import {getStorageManager} from '../src/storageManager.js';
import {deepAccess, deepSetValue, isFn, logError, mergeDeep} from '../src/utils.js';
import {config} from '../src/config.js';
import {includes} from '../src/polyfill.js';

const MODULE_NAME = 'permutive'

export const storage = getStorageManager({gvlid: null, moduleName: MODULE_NAME})

function init (moduleConfig, userConsent) {
  return true
}

/**
 * Set segment targeting from cache and then try to wait for Permutive
 * to initialise to get realtime segment targeting
 * @param {Object} reqBidsConfigObj
 * @param {function} callback - Called when submodule is done
 * @param {customModuleConfig} reqBidsConfigObj - Publisher config for module
 */
export function initSegments (reqBidsConfigObj, callback, customModuleConfig) {
  const permutiveOnPage = isPermutiveOnPage()
  const moduleConfig = getModuleConfig(customModuleConfig)
  const segmentData = getSegments(moduleConfig.params.maxSegs)

  setSegments(reqBidsConfigObj, moduleConfig, segmentData)

  if (moduleConfig.waitForIt && permutiveOnPage) {
    window.permutive.ready(function () {
      setSegments(reqBidsConfigObj, moduleConfig, segmentData)
      callback()
    }, 'realtime')
  } else {
    callback()
  }
}

/**
 * Merges segments into existing bidder config
 * @param {Object} customModuleConfig - Publisher config for module
 * @return {Object} Merged defatul and custom config
 */
function getModuleConfig (customModuleConfig) {
  return mergeDeep({
    waitForIt: false,
    params: {
      maxSegs: 500,
      acBidders: [],
      overwrites: {}
    }
  }, customModuleConfig)
}

/**
 * Sets ortb2 config for ac bidders
 * @param {Object} auctionDetails
 * @param {Object} customModuleConfig - Publisher config for module
 * @param {Object} iabTaxonomyData - data required for IAB taxonomy transformations (provided by Permutive SDK)
 */
export function setBidderRtb (auctionDetails, customModuleConfig, iabTaxonomyData) {
  const dataProviderName = 'permutive.com'

  const bidderConfig = config.getBidderConfig()
  const moduleConfig = getModuleConfig(customModuleConfig)
  const acBidders = deepAccess(moduleConfig, 'params.acBidders')
  const maxSegs = deepAccess(moduleConfig, 'params.maxSegs')
  const enabledIabTaxonomies = deepAccess(moduleConfig, 'params.iabTaxonomies') || []
  const segmentData = getSegments(maxSegs)

  const permutiveUserData = {
    name: dataProviderName,
    segment: segmentData.ac.map(segmentId => ({ id: segmentId })),
  }

  const iabUserData = createIabUserData(permutiveUserData, enabledIabTaxonomies, iabTaxonomyData)

  const userDataToAdd = iabUserData.length ? iabUserData.concat(permutiveUserData) : [permutiveUserData]

  acBidders.forEach(function (bidder) {
    const ortbConfig = bidderConfig[bidder] || {}

    const currentUserData = deepAccess(ortbConfig, 'ortb2.user.data') || []

    const updatedUserData = currentUserData
      .filter(el => el.name !== dataProviderName)
      .concat(userDataToAdd)

    deepSetValue(ortbConfig, 'ortb2.user.data', updatedUserData)

    config.setBidderConfig({
      bidders: [bidder],
      config: ortbConfig
    })
  })
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
      const defaultFn = getDefaultBidderFn(bidder)

      if (customFn) {
        customFn(bid, segmentData, acEnabled, utils, defaultFn)
      } else if (defaultFn) {
        defaultFn(bid, segmentData, acEnabled)
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
    fn()
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
 * Returns a function that receives a `bid` object, a `data` object and a `acEnabled` boolean
 * and which will set the right segment targeting keys for `bid` based on `data` and `acEnabled`
 * @param {string} bidder - Bidder name
 * @return {Object} Bidder function
 */
function getDefaultBidderFn (bidder) {
  const bidderMap = {
    appnexus: function (bid, data, acEnabled) {
      if (acEnabled && data.ac && data.ac.length) {
        deepSetValue(bid, 'params.keywords.p_standard', data.ac)
      }
      if (data.appnexus && data.appnexus.length) {
        deepSetValue(bid, 'params.keywords.permutive', data.appnexus)
      }

      return bid
    },
    rubicon: function (bid, data, acEnabled) {
      if (acEnabled && data.ac && data.ac.length) {
        deepSetValue(bid, 'params.visitor.p_standard', data.ac)
      }
      if (data.rubicon && data.rubicon.length) {
        deepSetValue(bid, 'params.visitor.permutive', data.rubicon)
      }

      return bid
    },
    ozone: function (bid, data, acEnabled) {
      if (acEnabled && data.ac && data.ac.length) {
        deepSetValue(bid, 'params.customData.0.targeting.p_standard', data.ac)
      }

      return bid
    }
  }

  return bidderMap[bidder]
}

/**
 * Check whether ac is enabled for bidder
 * @param {Object} moduleConfig - Module configuration
 * @param {string} bidder - Bidder name
 * @return {boolean}
 */
export function isAcEnabled (moduleConfig, bidder) {
  const acBidders = deepAccess(moduleConfig, 'params.acBidders') || []
  return includes(acBidders, bidder)
}

/**
 * Check whether Permutive is on page
 * @return {boolean}
 */
export function isPermutiveOnPage () {
  return typeof window.permutive !== 'undefined' && typeof window.permutive.ready === 'function'
}

/**
 * Get all relevant segment IDs in an object
 * @param {number} maxSegs - Maximum number of segments to be included
 * @return {Object}
 */
export function getSegments (maxSegs) {
  const legacySegs = readSegments('_psegs').map(Number).filter(seg => seg >= 1000000).map(String)
  const _ppam = readSegments('_ppam')
  const _pcrprs = readSegments('_pcrprs')

  const segments = {
    ac: [..._pcrprs, ..._ppam, ...legacySegs],
    rubicon: readSegments('_prubicons'),
    appnexus: readSegments('_papns'),
    gam: readSegments('_pdfps'),
  }

  for (const bidder in segments) {
    segments[bidder] = segments[bidder].slice(0, maxSegs)
  }

  return segments
}

/**
 * Gets an array of segment IDs from LocalStorage
 * or returns an empty array
 * @param {string} key
 * @return {string[]|number[]}
 */
function readSegments (key) {
  try {
    return JSON.parse(storage.getDataFromLocalStorage(key) || '[]')
  } catch (e) {
    return []
  }
}

const unknownIabSegmentId = '_unknown_'

/**
 * Function to create a new `user.data` objects for a IAB taxonomies.
 * @param  {number} userData              ORTB2 `user.data` object with (at least) `name` and `segment` properties
 * @param  {Object} enabledIabTaxonomies  array of objects with `id` keys representing IDs of IAB taxonomies
 * @param  {Object} iabTaxonomyData       object keyed by IAB taxonomy ID containing objects with `mappings` properties
 * @return {array}                        array of user data objects, transformed accordisng to enabled IAB taxonomies
 */
export function createIabUserData(userData, enabledIabTaxonomies, iabTaxonomyData) {
  return enabledIabTaxonomies
    .filter(({ id: taxonomyID }) => iabTaxonomyData.hasOwnProperty(taxonomyID))
    .map(({ id: taxonomyID }) => ({
      name: userData.name,
      ext: { segtax: taxonomyID },
      segment: (userData.segment || [])
        .map(segment => ({ id: (iabTaxonomyData[taxonomyID] && iabTaxonomyData[taxonomyID].mappings[segment.id]) || unknownIabSegmentId }))
        .filter(segment => segment.id !== unknownIabSegmentId)
    }))
}

/** @type {RtdSubmodule} */
export const permutiveSubmodule = {
  name: MODULE_NAME,
  getBidRequestData: function (reqBidsConfigObj, callback, customModuleConfig) {
    makeSafe(function () {
      // Legacy route with custom parameters
      initSegments(reqBidsConfigObj, callback, customModuleConfig)
    })
  },
  onAuctionInitEvent: function (auctionDetails, customModuleConfig) {
    makeSafe(function () {
      // Route for bidders supporting ORTB2
      setBidderRtb(auctionDetails, customModuleConfig, window.permutive.iabTaxonomyData || {})
    })
  },
  init: init
}

submodule('realTimeData', permutiveSubmodule)
