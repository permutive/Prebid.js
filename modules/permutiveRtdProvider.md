# Permutive Real-time Data Submodule

## Overview

    Module Name: Permutive Rtd Provider
    Module Type: Rtd Provider
    Maintainer: support@permutive.com

## Description

The Permutive real-time data module enables publishers to enrich bid requests with Permutive audience segments and targeting data. The module reads cohort data from local storage (set by the Permutive SDK) and attaches it to bid requests as first-party data following OpenRTB 2.x conventions.

Supported cohort types include:
- **Standard Cohorts**: IAB-compliant audience segments (segment IDs ≥ 1000000)
- **Custom Cohorts**: Publisher-defined audiences created in the Permutive dashboard
- **DCR Cohorts**: Data Clean Room cohorts for privacy-safe audience activation
- **Curation Cohorts**: SSP-specific curation signals for supply-side optimization

## Usage

### Build

Compile the Permutive RTD module into your Prebid build:

```
gulp build --modules=rtdModule,permutiveRtdProvider
```

> Note that the global RTD module, `rtdModule`, is a prerequisite of the Permutive RTD module.

### Configuration

Enable the Permutive RTD module in your Prebid configuration:

```javascript
pbjs.setConfig({
  realTimeData: {
    auctionDelay: 50, // optional auction delay
    dataProviders: [{
      name: 'permutive',
      waitForIt: true, // should be true if there's an auctionDelay
      params: {
        acBidders: ['appnexus', 'rubicon'],
        ccBidders: ['ozone']
      }
    }]
  }
})
```

### Parameters

| Name                   | Type                 | Description                                                                                   | Default            |
| ---------------------- | -------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| name                   | String               | Real-time data module name (always `permutive`)                                               | -                  |
| waitForIt              | Boolean              | Should be `true` if there's an `auctionDelay` defined                                         | `false`            |
| params                 | Object               | Module configuration parameters                                                               | -                  |
| params.acBidders       | String[]             | Bidder codes to receive Standard Cohorts and DCR Cohorts (see Standard Cohorts section)      | `[]`               |
| params.ccBidders       | String[]             | Bidder codes to receive Custom Cohorts (see Custom Cohorts section)                          | `[]`               |
| params.maxSegs         | Integer              | Maximum number of cohorts per cohort type                                                     | `500`              |

## GDPR and TCF Configuration

While Permutive is listed as a TCF vendor (ID: 361), Permutive does not obtain consent directly from the TCF. As a data processor, consent is managed by the Permutive SDK on behalf of publishers, not by Prebid's [GDPR Consent Management Module](https://docs.prebid.org/dev-docs/modules/consentManagement.html).

If GDPR enforcement is configured within the Permutive SDK and user consent is not granted, no cohorts will be passed to bidders.

### TCF Control Module Configuration

If you are using the [TCF Control Module](https://docs.prebid.org/dev-docs/modules/tcfControl.html), Permutive must be added as a vendor exception to prevent it from being blocked:

```javascript
pbjs.setConfig({
  consentManagement: {
    gdpr: {
      rules: [{
        purpose: 'storage',
        enforcePurpose: true,
        enforceVendor: true,
        vendorExceptions: ['permutive']
      }, {
        purpose: 'basicAds',
        enforcePurpose: true,
        enforceVendor: true,
        vendorExceptions: []
      }]
    }
  }
})
```

Before implementing this configuration, ensure it aligns with your organization's privacy policies and regulatory requirements.

## Cohort Configuration

### Standard Cohorts

Standard Cohorts are IAB-compliant audience segments that can be shared with demand partners. The module automatically includes DCR Cohorts (Data Clean Room) alongside Standard Cohorts when sharing with bidders.

**Prebid.js Version Requirements:**
- **Version 7.29.0+**: Standard Cohorts are shared via OpenRTB 2.x first-party data. Configure eligible bidders in the Permutive dashboard (see Managing acBidders below).
- **Version 7.13.0 - 7.28.x**: Use `params.acBidders` to specify which bidders should receive Standard Cohorts.
- **Version < 7.13.0**: Limited support. Upgrade recommended.

**Bidder-Specific Requirements:**
- **PubMatic or OpenX**: Prebid.js 7.13+
- **Xandr**: Prebid.js 7.29+
- **Equativ**: Prebid.js 7.26+

Standard Cohorts are sent to bidders in the `p_standard` keyword and as `ortb2.user.data` with provider name `permutive.com`. Curation Cohorts from SSPs are sent in the `p_standard_aud` keyword when applicable.

### Custom Cohorts

Custom Cohorts are publisher-defined audience segments created in the Permutive dashboard, typically used for direct deals and private marketplace (PMP) setups.

To enable Custom Cohorts for specific bidders, add their bidder codes to the `ccBidders` parameter:

```javascript
pbjs.setConfig({
  realTimeData: {
    dataProviders: [{
      name: 'permutive',
      params: {
        ccBidders: ['appnexus', 'rubicon', 'ozone']
      }
    }]
  }
})
```

**Legacy Bidder Support:**

The following bidders automatically receive Custom Cohorts for backwards compatibility, even if not included in `ccBidders`:
- Index Exchange (`ix`)
- Rubicon/Magnite (`rubicon`)
- AppNexus/Xandr (`appnexus`)
- Google Ad Manager (`gam`)

Custom Cohorts are read from the `_pprebid` local storage key (set by the Permutive SDK) and sent to target bidders in the `permutive` keyword and as `ortb2.user.data` with provider name `permutive`.

### Advertiser Cohorts

If you are using Permutive's Advertiser product to share cohorts with demand partners, add the relevant bidder codes to `params.acBidders` to enable Advertiser Cohort sharing.

### Managing acBidders

For Prebid.js version 7.13.0 and above, bidders can be managed directly in the Permutive Dashboard.

#### Dashboard Configuration

1. **Enable Prebid Integration**: Navigate to the integrations page in your Permutive dashboard settings and enable the Prebid integration.

   > **Note on Revenue Insights:** The Prebid integration includes a Revenue Insights feature, which is optional and not required for cohort activation. See the [Revenue Insights documentation](https://support.permutive.com/hc/en-us/articles/360019044079-Revenue-Insights) for more details.

2. **Configure Bidders**: In the "Data Provider config" section, enter valid bidder codes to enable Standard Cohorts, DCR Cohorts, or Advertiser Cohorts for specific partners. Refer to the [Prebid bidder codes list](https://docs.prebid.org/dev-docs/bidders.html) for valid values.

3. **Manual Override**: Bidders configured via the dashboard will automatically populate `params.acBidders`. If you have manually defined bidders in your Prebid configuration, dashboard settings will not override them.

#### Manual Configuration

Alternatively, you can manually define bidders in your Prebid configuration:

```javascript
pbjs.setConfig({
  realTimeData: {
    dataProviders: [{
      name: 'permutive',
      params: {
        acBidders: ['appnexus', 'rubicon', 'pubmatic']
      }
    }]
  }
})
```

**Note:** Manually configured bidders must be removed manually if no longer needed, as dashboard settings will not override them.

## Testing

To view an example of the Permutive RTD module:

```
gulp serve --modules=rtdModule,permutiveRtdProvider,appnexusBidAdapter
```

Then navigate to:

```
http://localhost:9999/integrationExamples/gpt/permutiveRtdProvider_example.html
```
