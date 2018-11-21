const Logger = require('@deity/falcon-logger');
const { ApiDataSource } = require('@deity/falcon-server-env');
const { AuthenticationError } = require('@deity/falcon-errors');
const util = require('util');
const { CronJob } = require('cron');
const addMinutes = require('date-fns/add_minutes');
const isPlainObject = require('lodash/isPlainObject');
const camelCase = require('lodash/camelCase');
const keys = require('lodash/keys');
const isEmpty = require('lodash/isEmpty');

const DEFAULT_KEY = '*';

const { codes } = require('@deity/falcon-errors');

/**
 * Base API features (configuration fetching, response parsing, token management etc.) required for communication
 * with Magento2. Extracted to separate class to keep final class clean (only resolvers-related logic should be there).
 */
module.exports = class Magento2ApiBase extends ApiDataSource {
  /**
   * Create Magento api wrapper instance
   * @param {object} params configuration params
   */
  constructor(params) {
    super(params);
    this.storePrefix = this.config.storePrefix || 'default';
    this.cookie = null;
    this.setupAdminTokenRefreshJob();
  }

  /**
   * Makes sure that context required for http calls exists
   * Gets basic store configuration from Magento
   * @return {object} Magento config
   */
  async preInitialize() {
    if (!this.context) {
      this.initialize({ context: {} });
    }

    const [storeConfigs, storeViews, storeGroups, storeWebsites] = await Promise.all([
      this.get('/store/storeConfigs'),
      this.get('/store/storeViews'),
      this.get('/store/storeGroups'),
      this.get('/store/websites')
    ]);

    const { data } = storeConfigs;
    const config = { ...data[0] };

    const {
      default_display_currency_code: baseCurrencyCode,
      locale,
      extension_attributes: extensionAttributes
    } = config;

    config.locale = locale.split('_')[0];
    const postCodes = extensionAttributes.optional_post_codes;
    const minPasswordLength = extensionAttributes.min_password_length;
    const minPasswordCharClass = extensionAttributes.min_password_char_class;
    const storeCodes = data.map(item => {
      const itemView = storeViews.data.find(view => item.code === view.code);
      const itemGroup = storeGroups.data.find(group => group.id === itemView.store_group_id);
      const itemWebsite = storeWebsites.data.find(website => itemGroup.website_id === website.id);
      const active = itemView.extension_attributes && itemView.extension_attributes.is_active;

      return {
        currency: item.default_display_currency_code,
        locale: item.locale && item.locale.split('_')[0],
        code: item.code,
        id: itemView.id,
        name: itemView.name,
        groupName: itemGroup.name,
        groupId: itemGroup.id,
        websiteName: itemWebsite.name,
        websiteId: itemWebsite.id,
        active: active !== undefined ? active : 1
      };
    });

    const activeStores = storeCodes.filter(item => item.active);

    this.magentoConfig = {
      ...config,
      stores: data,
      activeStores,
      minPasswordLength,
      minPasswordCharClass,
      baseCurrencyCode,
      postCodes
    };

    return this.magentoConfig;
  }

  initialize(config) {
    super.initialize(config);

    if (!this.context.session) {
      return;
    }

    const { customerToken } = this.session;
    if (customerToken && !this.isCustomerTokenValid(customerToken)) {
      this.session = {};
    }

    this.ensureStoreCode();
    this.ensureCurrency();

    this.context.session.save();
  }

  /**
   * Setup cronjob to check if  admin token is valid and refresh it if required
   */
  setupAdminTokenRefreshJob() {
    // run every minute
    this.refresh = new CronJob(
      '* * * * *',
      async () => {
        if (this.token && !this.isAdminTokenValid()) {
          Logger.debug('Refresh admin token');
          await this.retrieveAdminToken();
        }
      },
      null,
      true
    );
  }

  /**
   * Check if admin token is still valid
   * @return {boolean} true if token is valid
   */
  isAdminTokenValid() {
    Logger.debug(`this.tokenExpirationTime: ${this.tokenExpirationTime}`);
    return !this.tokenExpirationTime || (this.tokenExpirationTime && this.tokenExpirationTime > Date.now());
  }

  /**
   * Make request to the backend for admin token
   * @return {Promise<string>} admin token
   */
  async retrieveAdminToken() {
    Logger.info('Retrieving Magento token.');

    const response = await this.retrieveToken({ username: this.config.username, password: this.config.password });

    // data available only if retrieveToken is not wrapped with cache.
    const tokenData = this.convertKeys(response.data || response);
    const { token, validTime } = tokenData;
    if (token === undefined) {
      const noTokenError = new Error(
        'Magento Admin token not found. Did you install the falcon-magento2-module on magento?'
      );

      noTokenError.statusCode = 501;
      noTokenError.code = codes.CUSTOMER_TOKEN_NOT_FOUND;
      throw noTokenError;
    } else {
      Logger.info('Magento token found.');
    }
    this.token = token;
    this.tokenExpirationTime = null;

    if (validTime) {
      // convert validTime from hours to milliseconds and subtract 5 minutes buffer
      const tokenTimeInMinutes = validTime * 60 - 5;
      const tokenExpirationTime = addMinutes(Date.now(), tokenTimeInMinutes);

      this.tokenExpirationTime = tokenExpirationTime.getTime();
      Logger.debug(`Admin token valid for ${validTime} hours, till ${tokenExpirationTime.toString()}`);
    }

    return this.token;
  }

  /**
   * Retrieve token for given user.
   * @param {string} username magento2 user
   * @param {string} password magento2 user password
   * @return {object} response data
   */
  async retrieveToken({ username, password }) {
    return this.post('/integration/admin/token', { username, password }, { context: { skipAuth: true } });
  }

  /**
   * Helper method to recursively change key naming from underscore (snake case) to camelCase
   * @param {object} data - argument to process
   * @return {object} converted object
   */
  convertKeys(data) {
    // handle simple types
    if (!isPlainObject(data) && !Array.isArray(data)) {
      return data;
    }

    if (isPlainObject(data) && !isEmpty(data)) {
      const keysToConvert = keys(data);
      keysToConvert.forEach(key => {
        data[camelCase(key)] = this.convertKeys(data[key]);

        // remove snake_case key
        if (camelCase(key) !== key) {
          delete data[key];
        }
      });
    }

    if (Array.isArray(data)) {
      data.forEach((item, index) => {
        data[index] = this.convertKeys(item);
      });
    }

    return data;
  }

  /**
   * Resolves url based on passed parameters
   * @param {object} req - request params
   * @return {Promise<URL>} resolved url object
   */
  async resolveURL(req) {
    const { path } = req;
    let { storeCode } = this.session;
    if (storeCode) {
      req.params.delete(storeCode);
    } else {
      storeCode = this.storePrefix;
    }

    return super.resolveURL({
      path: `/rest/${storeCode}/V1${path}`
    });
  }

  /**
   * Authorize all requests, except case when authorization is explicitly disabled via context settings
   * @param {RequestOptions} req - request params
   */
  async willSendRequest(req) {
    const { context } = req;
    context.isAuthRequired = !context.skipAuth;
    await super.willSendRequest(req);
  }

  /**
   * Sets authorization headers for the passed request
   * @param {RequestOptions} req - request input
   */
  async authorizeRequest(req) {
    const { useAdminToken } = req.context || {};
    const { customerToken } = this.session || {};

    let token;
    // FIXME: it looks like `useAdminToken` flag is not used very often and do not cover all api requests
    // there is an assumption that if customer token is not provided then admin token should be used
    if (useAdminToken || !customerToken) {
      token = await this.getAdminToken();
    } else if (this.isCustomerTokenValid(customerToken)) {
      // eslint-disable-next-line prefer-destructuring
      token = customerToken.token;
    } else {
      const sessionExpiredError = new AuthenticationError(`Customer token has expired.`);
      sessionExpiredError.statusCode = 401;
      sessionExpiredError.code = codes.CUSTOMER_TOKEN_EXPIRED;
      throw sessionExpiredError;
    }

    req.headers.set('Authorization', `Bearer ${token}`);
    req.headers.set('Content-Type', 'application/json');
    req.headers.set('Cookie', this.cookie);
  }

  /**
   * @typedef {object} AuthToken
   * @property {string} token token
   * @property {number} expirationTime expiration time
   */

  /**
   * Check if authentication token is valid
   * @param {AuthToken} authToken - authentication token
   * @return {boolean} - true if token is valid
   */
  isCustomerTokenValid(authToken) {
    if (!authToken || !authToken.token || !authToken.expirationTime) {
      return false;
    }

    return authToken.expirationTime > Date.now();
  }

  /**
   * Get Magento api authorized admin token or perform request to create it.
   * @return {Promise<string>} token value
   */
  async getAdminToken() {
    if (!this.token) {
      if (!this.reqToken) {
        this.reqToken = this.retrieveAdminToken();
      }

      Logger.debug('Waiting for Magento token.');

      // this is called multiple times and may cause some problems with error handling
      return this.reqToken;
    }

    return this.token;
  }

  /**
   * Process received response data
   * @param {Response} response - received response from the api
   * @return {object} processed response data
   */
  async didReceiveResponse(response) {
    const cookies = (response.headers.get('set-cookie') || '').split('; ');
    const responseTags = response.headers.get('x-cache-tags');
    const data = await super.didReceiveResponse(response);
    const meta = {};

    if (responseTags) {
      meta.tags = responseTags.split(',');
    }

    if (cookies.length) {
      // For "customer/token" API call - we don't get PHPSESSID cookie
      cookies.forEach(cookieString => {
        if (cookieString.match(/PHPSESSID=(\w+\d+)/)) {
          this.cookie = cookieString.match(/PHPSESSID=(\w+\d+)/)[0];
        }
      });
    }

    const { search_criteria: searchCriteria } = data;

    if (!searchCriteria) {
      // no search criteria in response, simply return data from backend
      return { data, meta };
    }

    const { page_size: perPage = null, current_page: currentPage = 1 } = searchCriteria;
    const { total_count: total } = data;

    // process search criteria
    const pagination = this.processPagination(total, currentPage, perPage);
    return { data: { items: data.items, filters: data.filters || [], pagination }, meta };
  }

  /**
   * Handle error occurred during http response
   * @param {Error} error - error to process
   */
  didEncounterError(error) {
    const { extensions } = error;
    const { response } = extensions || {};

    // Re-formatting error message using provided response data from Magento
    if (response) {
      const { body } = response;
      const { message, parameters } = body || {};

      if (Array.isArray(parameters)) {
        error.message = util.format(message.replace(/(%\d)/g, '%s'), ...parameters);
      } else if (typeof parameters === 'object') {
        error.message = util.format(message.replace(/(%\w+\b)/g, '%s'), ...Object.values(parameters));
      } else {
        error.message = message;
      }
    }

    super.didEncounterError(error);
  }

  /**
   * Ensuring that user gets storeCode in the session with the first hit.
   *
   * Simple config structure:
   * {
   *     "store": {
   *       "enableSwitcher": false,
   *       "enableAutoDetection": true,
   *       // todo rename to geo mapping ?
   *       "mapping": {
   *         "*": "default",
   *         "UK": "uk_store_view",
   *         "US": "us_store_view"
   *       }
   *     }
   *   }
   * }
   *
   * Key is country code from geo ip, and value is a Magento store code.
   *
   * More custom config structure with an extra-check for user's preferred language:
   * {
   *     "store": {
   *       "enableSwitcher": false,
   *       "enableAutoDetection": true,
   *       "mapping": {
   *         "*": "default",
   *         "DK": {
   *           "*": "dk_en_store_view",
   *           "da": "dk_da_store_view"
   *         },
   *        "US": "us_store_view"
   *       }
   *     }
   *   }
   * }
   *
   * "*" - means value by default. It's required to have a default value, since it will be used as a fallback value.
   * Each element in "mapping" object may contain a string value or sub-mapping per language.
   *
   * @param {Request} req Koa request object
   */
  ensureStoreCode() {
    const { CountryCode: clientCountryCode } = this.context.headers;
    const { enableAutoDetection = false, geoMapping: storeMapping = {} } = this.config;
    const { storeCode, cart } = this.session;

    if (storeCode) {
      const isValidCode = this.magentoConfig.stores.find(({ code }) => code === storeCode);

      if (isValidCode) {
        Logger.debug(`Using existing session store code: ${storeCode}`);
      } else {
        Logger.warn(`Removing invalid user store code ${storeCode} from session.`);
        if (cart) {
          Logger.warn(`Removing cart from session assuming it was create in non existing
            store with code: ${storeCode}`);
          delete this.session.cart;
        }
        // api should use it's default if not present in session
        delete this.session.storeCode;
      }

      return;
    }

    if (!enableAutoDetection) {
      Logger.debug('Store code detection disabled.');
      return;
    }

    Logger.debug(`Detecting store for ${clientCountryCode} country code.`);

    const { [DEFAULT_KEY]: defaultStoreCode = 'default' } = storeMapping;

    // removes string after occurrence of passed separator (including the separator)
    const removeSubstring = (item, separator = ';') =>
      item.indexOf(separator) > 0 ? item.substring(0, item.indexOf(separator)) : item;

    let { [clientCountryCode]: clientStoreCode } = storeMapping;

    clientStoreCode = clientStoreCode || defaultStoreCode;

    if (clientStoreCode && typeof clientStoreCode === 'object') {
      const { 'accept-language': acceptLanguage } = this.context.headers;
      // Equals to a default mapped key
      let activeLanguage = DEFAULT_KEY;
      // Splitting accept-language header string with comma-separated values ("da,en-gb;q=0.8,en;q=0.7")
      const acceptLanguages = (acceptLanguage ? acceptLanguage.split(',') : [])
        // Extracting language parts (removing "priority" values, it's already sorted by priority)
        .map(item => removeSubstring(item))
        // Cleaning up the results ("en-US" -> "en")
        .map(item => removeSubstring(item, '-'));

      // Searching for available language in the language mapping for active country
      acceptLanguages.some(lang => {
        if (clientStoreCode[lang]) {
          activeLanguage = lang;
          return true;
        }
        return false;
      });

      clientStoreCode = clientStoreCode[activeLanguage];
    }

    if (clientStoreCode) {
      Logger.debug(`Using country detected store code: ${clientStoreCode}`);
      this.session.storeCode = clientStoreCode;
    }
  }

  /**
   * Ensure session has a currency code to be use for example for price formatting.
   * @param {object} session object
   */
  ensureCurrency() {
    const { storeCode } = this.session;

    // todo: use sensible defaults instead of EUR
    let userCurrency = this.config.currency && (this.config.currency.symbol || 'EUR');

    Logger.debug('Detecting currency');

    if (storeCode && this.magentoConfig.activeStores.length) {
      const activeStore = this.magentoConfig.activeStores.find(item => item.code === storeCode);

      if (activeStore) {
        Logger.debug(`Found active store: ${activeStore.code}, currency changed to ${activeStore.currency}`);
        userCurrency = activeStore.currency;
      } else {
        Logger.debug(`Not found active store for code: ${storeCode}, currency changed to default: ${this.currency}`);
      }
    } else {
      Logger.debug('No store code or store inactive.');
    }

    this.session.currency = userCurrency;
  }
};
