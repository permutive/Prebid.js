## Prebid Config for Permutive RTD Module

This module reads cohorts from the Permutive SDK's cohort store and attaches them to bid requests as first-party data.

### _Permutive Real-time Data Submodule_

#### Usage

Compile the Permutive RTD module into your Prebid build:

```
gulp build --modules=rtdModule,permutiveRtdProvider
```

> Note that the global RTD module, `rtdModule`, is a prerequisite of the Permutive RTD module.

You then need to enable the Permutive RTD in your Prebid configuration. Below is an example of the format:

```javascript
pbjs.setConfig({
  ...,
  realTimeData: {
    auctionDelay: 50, // optional auction delay
    dataProviders: [{
      name: 'permutive',
      waitForIt: true // should be true if there's an `auctionDelay`
    }]
  },
  ...
})
```

No further configuration is required: the module routes cohorts according to the cohort store maintained by the Permutive SDK (see "How cohorts are routed" below), which reflects the activations configured in the Permutive dashboard. The parameters below are available for overrides and special cases.

## Parameters

{: .table .table-bordered .table-striped }
| Name                        | Type     | Description                                                                                      | Default |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------ | ------- |
| name                        | String   | This should always be `permutive`                                                                | -       |
| waitForIt                   | Boolean  | Should be `true` if there's an `auctionDelay` defined (optional)                                 | `false` |
| params                      | Object   |                                                                                                  | -       |
| params.maxSegs              | Integer  | Maximum number of cohorts written per ORTB2 location.                                            | `500`   |
| params.enforceVendorConsent | Boolean  | When `true`, require TCF vendor consent for Permutive (vendor 361). See Consent below.           | `false` |
| params.bidders              | Object   | Per-bidder overrides: a custom cohort source and/or a placement override. See below.             | `{}`    |
| params.locations            | Object   | Additional ORTB2 location definitions, merged over the built-in defaults. See below.             | `{}`    |
| params.placement            | Object   | Placement policy overrides mapping cohort categories to location ids. See below.                 | `{}`    |

#### Consent

While Permutive is listed as a TCF vendor (ID: 361), Permutive does not typically obtain vendor consent from the TCF, but instead relies on the publisher purpose consents. Publishers wishing to use TCF vendor consent instead can add 361 to their CMP and set params.enforceVendorConsent to `true`.

## How cohorts are routed

The Permutive SDK maintains a normalised cohort store under the `_pcohorts` localStorage key. The user's cohorts appear once, grouped by category, and each bidder carries a list of references into those categories:

```json
{
  "categories": {
    "standard": ["10000123", "10000456"],
    "dcr": ["cr_12"],
    "curated": ["IAB42"],
    "clm": ["clm_5"],
    "custom": ["275361"]
  },
  "activations": {
    "ortb2": {
      "appnexus": ["10000123", "cr_12", "IAB42", "275361"],
      "rubicon": ["275361"]
    }
  }
}
```

Every bidder listed under `activations.ortb2` receives its referenced cohorts — no Prebid configuration needed. Each referenced cohort is resolved to its category, and the category's placement policy decides which ORTB2 locations it is written to. Cohorts targeting the same location are deduplicated, and `params.maxSegs` is enforced per location.

### Locations and placement

ORTB2 destinations are declared once as *locations* and referenced by id from *placement* policies. The built-in defaults:

{: .table .table-bordered .table-striped }
| Location id | Writes to                                                |
| ----------- | -------------------------------------------------------- |
| `pcom`      | `user.data` entry named `permutive.com`                   |
| `pstd_kw`   | `user.keywords` as `p_standard=<cohort>`                  |
| `psaud_kw`  | `user.keywords` as `p_standard_aud=<cohort>`              |
| `pstd_ext`  | `user.ext.data.p_standard`                                |
| `pstd_site` | `site.ext.permutive.p_standard`                           |
| `perm`      | `user.data` entry named `permutive`                       |
| `perm_kw`   | `user.keywords` as `permutive=<cohort>`                   |
| `perm_ext`  | `user.ext.data.permutive`                                 |

{: .table .table-bordered .table-striped }
| Category   | Default placement                                      |
| ---------- | ------------------------------------------------------ |
| `standard` | `pcom`, `pstd_kw`, `pstd_ext`, `pstd_site`             |
| `dcr`      | `pcom`, `pstd_kw`, `pstd_ext`, `pstd_site`             |
| `curated`  | `pcom`, `pstd_kw`, `psaud_kw`, `pstd_ext`, `pstd_site` |
| `clm`      | `perm`, `perm_kw`, `perm_ext`                          |
| `custom`   | `perm`, `perm_kw`, `perm_ext`                          |

Both can be extended or overridden via config — globally with `params.locations` / `params.placement`, or per bidder with `params.bidders.<bidder>.placement`:

```javascript
params: {
  locations: {
    audtax: { path: 'user.data', name: 'permutive.com', ext: { segtax: 4 } }
  },
  placement: {
    curated: ['audtax', 'psaud_kw']
  },
  bidders: {
    rubicon: {
      placement: { custom: ['perm'] }
    }
  }
}
```

Supported location paths are `user.data` (requires `name`, optional `ext`), `user.keywords`, `user.ext.data` and `site.ext.permutive` (each requires `key`). Only these paths can be written to. A `user.data` location's `ext` (e.g. `{ segtax: 600 }`) is attached to the resulting entry, and locations with the same name but different `ext` values produce separate entries. Dangling cohort references and unknown location ids are dropped with a console warning, never silently.

### Custom cohort sources

A bidder can be pointed at a different cohort source with `params.bidders.<bidder>.customCohorts`:

```javascript
params: {
  bidders: {
    msft: {
      // With a path: read the reference list at that path and resolve it
      // against that store's categories
      customCohorts: { source: 'ls', key: '_pcohorts', path: 'activations.ortb2.msft' }
    },
    other: {
      // Without a path: read the whole key as a flat list of custom cohort IDs
      customCohorts: { source: 'ls', key: '_pcustom_other' }
    }
  }
}
```

## Local Storage

The module reads the following localStorage keys, written by the Permutive SDK and disclosed in [Permutive's device storage disclosure](https://assets.permutive.app/tcf/tcf.json):

{: .table .table-bordered .table-striped }
| Key                    | Contents                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `_pcohorts`            | Normalised cohort store: categories and per-bidder activations |
| `permutive-prebid-rtd` | Cached module configuration                                    |

Keys configured via `params.bidders.<bidder>.customCohorts.key` are also read.

> Note: the legacy keys read by earlier versions of this module (`_psegs`, `_ppam`, `_pcrprs`, `_pssps`, `_papns`, `_prubicons`, `_pindexs`, `_pdfps`, `_ppsts`) are no longer read, and the `params.acBidders`, `params.transformations` and `params.overwrites` options have been removed. Cohort routing is driven by the `_pcohorts` store instead.
