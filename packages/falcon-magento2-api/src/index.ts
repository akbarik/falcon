import url from 'url';
import qs from 'qs';
import urlJoin from 'proper-url-join';
import addMinutes from 'date-fns/add_minutes';
import isEmpty from 'lodash/isEmpty';
import pick from 'lodash/pick';
import has from 'lodash/has';
import forEach from 'lodash/forEach';
import snakeCase from 'lodash/snakeCase';
import { OperationInput } from '@deity/falcon-data';
import { ProductListInput } from '@deity/falcon-shop-extension';
import { ApiUrlPriority, stripHtml, graphqlFragmentFields } from '@deity/falcon-server-env';
import { Magento2ApiBase } from './Magento2ApiBase';
import { tryParseNumber } from './utils/number';
import { typeResolverPathToString } from './utils/apollo';

const FALCON_CART_ACTIONS = [
  '/save-payment-information-and-order',
  '/paypal-express-fetch-token',
  '/paypal-express-return',
  '/paypal-express-cancel',
  '/place-order'
];

/** Magento visibility settings */
const ProductVisibility = {
  notVisible: 1,
  catalog: 2,
  search: 3,
  catalogAndSearch: 4
};

/**
 * API for Magento2 store - provides resolvers for shop schema.
 */
module.exports = class Magento2Api extends Magento2ApiBase {
  /**
   * Adds additional resolve functions to the stitched GQL schema for the sake of data-splitting
   * @param {Function} apiGetter
   */
  static getExtraResolvers(apiGetter) {
    return {
      ShopConfig: {
        stores: apiGetter(api => api.getActiveStores()),
        currencies: apiGetter(api => api.getActiveCurrencies()),
        baseCurrency: apiGetter(api => api.session.baseCurrency),
        timezone: apiGetter(api => api.session.timezone),
        weightUnit: apiGetter(api => api.session.weightUnit),
        activeCurrency: apiGetter(api => api.session.currency),
        activeStore: apiGetter(api => api.session.storeCode),
        sortOrderList: apiGetter(api => api.getSortOrderList())
      },
      Product: {
        price: apiGetter((api, ...args) => api.productPrice(...args)),
        tierPrices: apiGetter((api, ...args) => api.productTierPrices(...args)),
        options: apiGetter((api, ...args) => api.productOptions(...args)),
        breadcrumbs: apiGetter((api, ...args) => api.breadcrumbs(...args))
      },
      Category: {
        breadcrumbs: apiGetter((api, ...args) => api.breadcrumbs(...args)),
        productList: apiGetter((api, ...args) => api.categoryProductList(...args)),
        children: apiGetter((api, ...args) => api.categoryChildren(...args))
      },
      PaymentMethod: {
        config: apiGetter((api, ...args) => api.getPaymentMethodConfig(...args))
      },
      Address: {
        country: apiGetter((api, ...args) => api.country(...args)),
        region: apiGetter((api, ...args) => api.addressRegion(...args))
      }
    };
  }

  async getActiveStores() {
    return this.storeList.map(storeWebsite => ({
      name: storeWebsite.name,
      code: storeWebsite.defaultStore.code
    }));
  }

  async getActiveCurrencies() {
    const currentStoreConfig = this.getActiveStoreConfig();
    const currencies = [];
    forEach(this.storeConfigMap, storeConfig => {
      if (currentStoreConfig && currentStoreConfig.store_group_id === storeConfig.store_group_id) {
        currencies.push(storeConfig.default_display_currency_code);
      }
    });
    return currencies;
  }

  getSortOrderList() {
    return [
      {
        name: 'Position',
        value: undefined,
        __typename: 'SortOrder'
      },
      {
        name: 'Price ascending',
        value: {
          field: 'price',
          direction: 'asc',
          __typename: 'SortOrderValue'
        },
        __typename: 'SortOrder'
      },
      {
        name: 'Price descending',
        value: {
          field: 'price',
          direction: 'desc',
          __typename: 'SortOrderValue'
        },
        __typename: 'SortOrder'
      },
      {
        name: 'Name ascending',
        value: {
          field: 'name',
          direction: 'asc',
          __typename: 'SortOrderValue'
        },
        __typename: 'SortOrder'
      },
      {
        name: 'Name descending',
        value: {
          field: 'name',
          direction: 'desc',
          __typename: 'SortOrderValue'
        },
        __typename: 'SortOrder'
      }
    ];
  }

  /**
   * Fetch Menu
   * @returns {Promise<MenuItem[]>} requested Menu data
   */
  async menu() {
    const response = await this.getForIntegration('/falcon/menus');
    const menuItems = this.convertKeys(response);

    const mapMenu = x => {
      if (!x) {
        return [];
      }

      if (Array.isArray(x)) {
        return x.map(mapMenu);
      }

      return {
        ...x,
        urlPath: urlJoin(x.urlPath, undefined, { leadingSlash: true }),
        children: mapMenu(x.children)
      };
    };

    return mapMenu(menuItems);
  }

  /**
   * Fetch category data
   * @param {object} obj Parent object
   * @param {number} id id of the requested category
   * @returns {Promise<Category>} - converted response with category data
   */
  async category(obj, { id }) {
    const response = await this.getForIntegration(`/categories/${id}`);
    return this.convertCategory(response);
  }

  /**
   * Fetch products for fetched category
   * @param {object} obj fetched category
   * @param params query params
   * @returns {Promise<CategoryProductList>} - fetched list of products
   */
  async categoryProductList(obj, params: Partial<OperationInput<ProductListInput>> = {}) {
    const { input = {} } = params;
    const { pagination = {} } = input;

    const searchCriteria = this.createSearchCriteria(input);
    this.addSearchFilter(searchCriteria, 'visibility', ProductVisibility.catalogAndSearch, 'eq');
    if (!this.isFilterSet('status', input)) {
      this.addSearchFilter(searchCriteria, 'status', '1');
    }
    // removed virtual products as we're not supporting it
    this.addSearchFilter(searchCriteria, 'type_id', 'simple,configurable,bundle', 'in');

    let response;
    try {
      response = await this.getForIntegration(
        `/falcon/categories/${obj.id}/products`,
        { searchCriteria },
        { context: { pagination } }
      );
    } catch (ex) {
      // if is_anchor is set to "0" then we cannot fetch category contents (as it doesn't have products)
      // in that case if Magento returns error "Bucked does not exist" we return empty array to avoid displaying errors
      if (ex.message.match(/Bucket does not exist/) && obj.custom_attributes.is_anchor === '0') {
        return {
          items: [],
          pagination: this.processPagination(0)
        };
      }
      throw ex;
    }

    return {
      items: response.items.map(item => this.reduceProduct(item)),
      aggregations: this.processAggregations(response.filters),
      pagination: response.pagination
    };
  }

  /**
   * Process category data from Magento2 response
   * @param {object} data categoryObject from Magento2 backend
   * @returns {Category} processed response
   */
  convertCategory(data) {
    this.convertAttributesSet(data);
    const { custom_attributes: customAttributes } = data;

    // for specific category record
    let urlPath = customAttributes.url_path;

    if (!urlPath) {
      // in case of categories tree - URL path can be found in data.url_path
      urlPath = data.url_path;
      delete data.url_path;
    }

    delete data.created_at;
    delete data.product_count;

    data.urlPath = this.convertPathToUrl(urlPath);

    return data;
  }

  /**
   * Convert attributes from array of object into flat key-value pair,
   * where key is attribute code and value is attribute value
   * @param {object} response response from Magento2 backend
   * @returns {object} converted response
   */
  convertAttributesSet(response) {
    const { custom_attributes: attributes = [] } = response;
    const attributesSet = {};

    if (Array.isArray(attributes)) {
      attributes.forEach(attribute => {
        attributesSet[attribute.attribute_code] = attribute.value;
      });

      response.custom_attributes = attributesSet;
    }

    return response;
  }

  /**
   * Add leading slash and suffix to path
   * @param {string} path path to convert
   * @returns {string} converted path
   * @todo get suffix from Magento2 config
   */
  convertPathToUrl(path) {
    if (path) {
      if (!path.endsWith(this.itemUrlSuffix)) {
        path += this.itemUrlSuffix;
      }
      if (path[0] !== '/') {
        path = `/${path}`;
      }
    }

    return path;
  }

  /**
   * Convert breadcrumbs for category, product entities
   * @param {Array<object>} breadcrumbs  array of breadcrumbs entries from Magento
   * @returns {Breadcrumb[]} converted breadcrumbs
   */
  convertBreadcrumbs(breadcrumbs = []) {
    return breadcrumbs.map(item => {
      item.name = stripHtml(item.name);
      item.urlPath = this.convertPathToUrl(item.urlPath);
      item.urlQuery = null;
      if (item.urlQuery && Array.isArray(item.urlQuery)) {
        // since Magento2.2 we are no longer able to send arbitrary hash, it gets converted to JSON string
        const filters = typeof item.urlQuery[0] === 'string' ? JSON.parse(item.urlQuery[0]) : item.urlQuery[0];
        item.urlQuery = { filters };
      }

      if (item.urlQuery) {
        item.urlPath += `?${qs.stringify(item.urlQuery)}`;
      }

      return item;
    });
  }

  /**
   * Get list of products based on filters from params
   * @param {object} obj Parent object
   * @param {object} params request params
   * @param {number} params.categoryId id of the category to search in
   * @param {boolean} params.includeSubcategories flag indicates if products from subcategories should be included
   * @param {ShopPageQuery} params.query definitions of aggregations
   * @param {SortOrder[]} params.sortOrders definition of sort orders
   * @param {Filter[]} params.filters filters that should be used for filtering
   * @param {string[]} params.skus skus of products that search should be narrowed to
   * @returns {Promise<Product[]>}  response with list of products
   */
  async productList(obj, { input }) {
    const { withAttributeFilters = [] } = input;
    const searchCriteria = this.createSearchCriteria(input);

    this.addSearchFilter(searchCriteria, 'visibility', ProductVisibility.catalogAndSearch, 'eq');
    if (!this.isFilterSet('status', searchCriteria)) {
      this.addSearchFilter(searchCriteria, 'status', '1');
    }
    // removed virtual products as we're not supporting it - feature request: RG-1086
    this.addSearchFilter(searchCriteria, 'type_id', 'simple,configurable,bundle', 'in');

    const response = await this.getForIntegration('/products', {
      includeSubcategories: true,
      withAttributeFilters,
      searchCriteria
    });

    return {
      items: response.items.map(x => this.reduceProduct(x, this.session.currency)),
      pagination: this.processPagination(response.total_count, searchCriteria.currentPage, searchCriteria.pageSize)
    };
  }

  /**
   * Converts passed params to format acceptable by Magento
   * @param {object} params parameters passed to the resolver
   * @returns {object} params converted to format acceptable by Magento
   */
  createSearchCriteria(params) {
    const { filters = [], pagination, sort = {} } = params;

    const processedFilters = {
      filterGroups: params.filterGroups
    };
    filters.forEach(item => {
      if (item.value) {
        this.addSearchFilter(processedFilters, snakeCase(item.field), item.value, item.operator);
      }
    });

    return {
      filterGroups: processedFilters.filterGroups,
      sortOrders: Array.isArray(sort) ? sort : [sort],
      currentPage: parseInt(pagination && pagination.page, 10) || 1,
      pageSize: parseInt(pagination && pagination.perPage, 10) || this.perPage
    };
  }

  /**
   * Include field to list of filters. Used when making request to listing endpoint.
   * @param {object} params request params that should be populated with filters
   * @param {string} field filter field to include
   * @param {string} value field value
   * @param {string} operator condition type of the filter
   * @returns {object} - request params with additional filter
   */
  addSearchFilter(params: any = {}, field, value, operator = 'eq') {
    params.filterGroups = isEmpty(params.filterGroups) ? [] : params.filterGroups;
    const newFilterGroups = this.createMagentoFilter(field, value, operator);
    newFilterGroups.forEach(filterGroup => params.filterGroups.push(filterGroup));

    return params;
  }

  /**
   * Converts filter entry to Magento compatible filters format
   * See https://devdocs.magento.com/guides/v2.3/rest/performing-searches.html for the details
   * @param {string} field field name
   * @param {string|Array<string>} value value of the field
   * @param {FilterOperator} operator filter operator
   * @returns {object} Magento-compatible filters definition
   */
  createMagentoFilter(field, value, operator) {
    if (!Array.isArray(value)) {
      value = [value];
    }

    switch (operator) {
      case 'eq': {
        const filters = [];
        value.forEach(val => filters.push(this.createSimpleFilter(field, val, operator)));
        // for 'eq' return one filter group with multiple entries inside when user passes array of values
        return [
          {
            filters
          }
        ];
      }

      case 'neq': {
        const output = [];
        output.push({ filters: [this.createSimpleFilter(field, value[0], operator)] });

        // if multiple 'neq' values have been passed then these must be joined with AND, so separate
        // filterGroups must be used
        // @todo: consider using 'nin' filter when multiple values are passed - that would simplify final filter
        if (value.length > 1) {
          value.slice(1).forEach(val =>
            output.push({
              filters: [this.createSimpleFilter(field, val, operator)]
            })
          );
        }

        return output;
      }

      case 'lt':
      case 'gt':
      case 'lte':
      case 'gte':
        // map lte to lteq and gte to gteq
        return [
          {
            filters: [this.createSimpleFilter(field, value[0], operator.endsWith('e') ? `${operator}q` : operator)]
          }
        ];

      case 'in':
      case 'nin':
        // join values with comma
        return [
          {
            filters: [this.createSimpleFilter(field, value.join(','), operator)]
          }
        ];

      case 'range':
        // translate range to 'from' - 'to' filters - because 'range' doesn't work in Magento
        return [
          {
            filters: [this.createSimpleFilter(field, value[0], 'from'), this.createSimpleFilter(field, value[1], 'to')]
          }
        ];

      default:
        return [];
    }
  }

  /**
   * Creates single filter entry in Magento format
   * @param {string} field field name
   * @param {string} value filter value
   * @param {string} operator filter operator to be used
   * @returns {object} Magento filter
   */
  createSimpleFilter(field, value, operator) {
    return {
      condition_type: operator,
      field,
      value
    };
  }

  /**
   * Check if given filter is set in params
   * @param {string} filterName name of the filter
   * @param {object} params params with filters
   * @returns {boolean} if filter is set
   */
  isFilterSet(filterName, params: any = {}) {
    const { filters = [] } = params || {};

    return filters.some(({ filters: filterItems = [] }) =>
      filterItems.some(filterItem => filterItem.field === filterName)
    );
  }

  /**
   * Reduce product data to what is needed.
   * @param {object} data API response from Magento2 backend
   * @param {string} currency currency code
   * @returns {Product} reduced data
   */
  reduceProduct(data, currency = null) {
    this.convertAttributesSet(data);
    data = this.convertKeys(data);

    const resolveGallery = product => {
      const { extensionAttributes: attrs, mediaGallerySizes } = product;
      if (attrs && attrs.mediaGallerySizes) {
        return attrs.mediaGallerySizes;
      }

      return mediaGallerySizes || [];
    };
    const { customAttributes = {} } = data;
    const result = {
      ...data,
      id: data.id || data.sku, // temporary workaround until Magento returns product id correctly
      sku: data.sku,
      urlPath: this.convertPathToUrl(data.urlPath || customAttributes.urlKey),
      currency,
      name: stripHtml(data.name),
      description: customAttributes.description,
      thumbnail: data.image || customAttributes.image,
      gallery: resolveGallery(data),
      seo: {
        title: customAttributes.metaTitle,
        description: customAttributes.metaDescription,
        keywords: customAttributes.metaKeyword
      }
    };

    if (data.extensionAttributes) {
      const { thumbnailUrl, stockItem, configurableProductOptions, bundleProductOptions } = data.extensionAttributes;

      // old API passes thumbnailUrl in extension_attributes, new api passes image field directly
      result.thumbnail = thumbnailUrl || data.image;

      if (stockItem) {
        result.stock = pick(stockItem, 'qty', 'isInStock');
      }

      result.options = configurableProductOptions || [];

      if (bundleProductOptions) {
        // remove extension attributes for option product links
        bundleProductOptions.forEach(option => {
          const dataLink = option.productLinks.map(productLink => ({
            ...productLink,
            ...productLink.extensionAttributes
          }));
          option.productLinks = dataLink;
        });

        result.bundleOptions = bundleProductOptions;
      }
    }

    return result;
  }

  /**
   * Resolve Product Price from Product
   * @param {object} parent parent (MagentoProduct or MagentoProductListItem)
   * @returns {ProductPrice} product price
   */
  productPrice(parent) {
    const { price } = parent;

    return {
      regular: tryParseNumber(price.regularPrice) || tryParseNumber(price) || 0.0,
      special: tryParseNumber(price.specialPrice),
      minTier: tryParseNumber(price.minTierPrice)
    };
  }

  /**
   * Resolve Product Tier Price from Product
   * @param {object} parent parent (MagentoProduct or MagentoProductListItem)
   * @param {object} args arguments
   * @param {object} context context
   * @param {object} info info
   * @returns {TierPrice[]} product price
   */
  async productTierPrices(parent, args, context, info) {
    // a parent could be an item of Magento Product List, which does not contain necessary data, so we need to fetch Product by its id
    const data = typeResolverPathToString(info.path).startsWith('category.products')
      ? await this.fetchProduct(parent.id)
      : parent;

    const { price, tierPrices = [] } = data;
    const regularPrice = tryParseNumber(price.regularPrice) || 0.0;

    return tierPrices.map(tierPrice => ({
      qty: tierPrice.qty,
      value: tierPrice.value,
      discount: regularPrice ? 100 - (100 * tierPrice.value) / regularPrice : 0.0
    }));
  }

  /**
   * Resolve Product Options from Product
   * @param {object} parent parent (MagentoProduct or MagentoProductListItem)
   * @param {object} args arguments
   * @param {object} context context
   * @param {object} info info
   * @returns {ProductOption} product options
   */
  async productOptions(parent, args, context, info) {
    // a parent could be an item of Magento Product List, which does not contain necessary data, so we need to fetch Product by its id
    const data = typeResolverPathToString(info.path).startsWith('category.products')
      ? await this.fetchProduct(parent.id)
      : parent;

    if (!data.extensionAttributes || !Array.isArray(data.extensionAttributes.configurableProductOptions)) {
      return [];
    }

    return data.extensionAttributes.configurableProductOptions.map(({ values, ...restOptions }) => ({
      ...restOptions,
      values: values.map(({ extensionAttributes = {}, ...x }) => ({
        valueIndex: x.valueIndex,
        inStock: extensionAttributes.inStock || [],
        label: extensionAttributes.label
      }))
    }));
  }

  /**
   * Returns a priority factor for the given path (how likely it is to be handled by this middleware)
   * @param {string} path path to check
   * @returns {number} - priority factor
   */
  getFetchUrlPriority(path) {
    return path.endsWith(this.itemUrlSuffix) ? ApiUrlPriority.HIGH : ApiUrlPriority.NORMAL;
  }

  getCacheContext() {
    return {
      storeCode: this.getStoreCode()
    };
  }

  /**
   * Special endpoint to fetch any magento entity by it's url, for example product, cms page
   * @param {object} _ Parent object
   * @param {object} params request params
   * @param {string} [params.path] request path to be checked against api urls
   * @param {boolean} [params.loadEntityData] flag to mark whether endpoint should return entity data as well
   * @returns {Promise} - request promise
   */
  async fetchUrl(_, params) {
    const { path } = params;

    return this.get(
      '/falcon/urls/',
      { url: path.replace(/^\//, '') },
      {
        context: {
          didReceiveResult: async result => ({
            id: result.entity_id,
            path: `/${result.canonical_url.replace(/^\//, '')}`,
            type: `shop-${result.entity_type.toLowerCase().replace('cms-', '')}`
          })
        }
      }
    );
  }

  /**
   * Search for product with id
   * @param {object} obj Parent object
   * @param {string} id product id called by magento entity_id
   * @returns {Promise<Product>} product data
   */
  async product(obj, { id }) {
    const data = await this.fetchProduct(id);

    return this.reduceProduct(data);
  }

  async fetchProduct(id) {
    const data = await this.getForIntegration(`/falcon/products/${id}`);
    this.convertAttributesSet(data);

    return this.convertKeys(data);
  }

  /**
   * Add product to cart
   * @param {object} obj Parent object
   * @param {object} input product data
   * @param {string} input.sku added product sku
   * @param {number} input.qty added product qty
   * @returns {Promise<CartItemPayload>} - cart item data
   */
  async addToCart(obj, { input }) {
    const cartData = await this.ensureCart();
    const cartPath = this.getCartPath();

    const product = {
      cart_item: {
        sku: input.sku,
        qty: input.qty,
        quote_id: cartData.quoteId,
        product_option: undefined
      }
    };

    if (input.options) {
      product.cart_item.product_option = {
        extension_attributes: {
          configurable_item_options: input.options.map(item => ({
            option_id: item.id,
            option_value: item.value
          }))
        }
      };
    }

    // TODO: I think we should do `Array.isArray(input.bundleOptions) && input.bundleOptions.length` instead
    if (input.bundleOptions) {
      product.cart_item.product_option = {
        extension_attributes: {
          bundle_options: input.bundleOptions.map(x => ({
            option_id: x.id,
            option_qty: x.qty,
            option_selections: x.selections
          }))
        }
      };
    }

    try {
      const cartItem = await this.postAuth(`${cartPath}/items`, product);

      this.convertKeys(cartItem);
      this.processPrice(cartItem, ['price']);

      return cartItem;
    } catch (e) {
      // Pass only helpful message to end user
      if (e.statusCode === 400) {
        // this is working as long as Magento doesn't translate error message - which seems not the case as of 2.2
        if (e.message.match(/^We don't have as many/)) {
          e.code = 'STOCK_TOO_LOW';
          e.userMessage = true;
          e.noLogging = true;
        }
      } else if (e.message.match(/^No such entity with cartId/)) {
        this.removeCartData();
        e.code = 'INVALID_CART';
      }

      throw e;
    }
  }

  /**
   * Merges guest cart with the cart of the signed in user
   * @param {string} guestQuoteId masked id of guest cart
   * @returns {object} - new cart data
   */
  async mergeGuestCart(guestQuoteId) {
    // send masked_quote_id as param so Magento merges guest's cart with user's cart
    const response = await this.postAuth('/falcon/carts/mine', { masked_quote_id: guestQuoteId });
    this.session.cart = { quoteId: response };

    return this.session.cart;
  }

  /**
   * Ensure customer has cart in the session.
   * Creates cart if it doesn't yet exist.
   * @returns {object} - new cart data
   */
  async ensureCart() {
    const { cart } = this.session;

    if (cart && cart.quoteId) {
      return cart;
    }

    const response = await this.postAuth(this.isCustomerLoggedIn() ? '/falcon/carts/mine' : '/guest-carts');

    this.session.cart = { quoteId: response };
    this.context.session.save();

    return this.session.cart;
  }

  /**
   * Generate prefix for path to cart based on current user session state
   * @returns {string} - prefix for cart endpoints
   */
  getCartPath() {
    const { cart } = this.session;

    if (!this.isCustomerLoggedIn() && !cart) {
      throw new Error('No cart in session for not registered user.');
    }

    return this.isCustomerLoggedIn() ? '/carts/mine' : `/guest-carts/${cart.quoteId}`;
  }

  /**
   * Make sure price fields are float
   * @param {object} data object to process
   * @param {string[]} fieldsToProcess array with field names
   * @returns {object} updated object
   */
  processPrice(data = {}, fieldsToProcess = []) {
    fieldsToProcess.forEach(field => {
      data[field] = parseFloat(data[field]);
    });

    return data;
  }

  /**
   * Get cart data
   * @returns {Promise<Cart>} - customer cart data
   */
  async cart() {
    const quoteId = this.session.cart && this.session.cart.quoteId;
    const emptyCart = {
      active: false,
      itemsQty: 0,
      items: [],
      totals: []
    };

    if (!quoteId) {
      return emptyCart;
    }

    // todo avoid calling both endpoints if not necessary
    const cartPath = this.getCartPath();

    try {
      const [quote, totals] = await Promise.all([
        this.getAuth(cartPath, {}, { context: { didReceiveResult: result => this.convertKeys(result) } }),
        this.getAuth(`${cartPath}/totals`, {}, { context: { didReceiveResult: result => this.convertKeys(result) } })
      ]);
      return this.convertCartData(quote, totals);
    } catch (ex) {
      // can't fetch cart so remove its data from session
      this.removeCartData();
      return emptyCart;
    }
  }

  /**
   * Process and merge cart and totals response
   * @param {object} quoteData data from cart endpoint
   * @param {object} totalsData data from cart totals endpoint
   * @returns {Cart} object with merged data
   */
  convertCartData(quoteData, totalsData) {
    quoteData.active = quoteData.isActive;
    quoteData.virtual = quoteData.isVirtual;
    quoteData.quoteCurrency = totalsData.quoteCurrencyCode;
    quoteData.couponCode = totalsData.couponCode;

    // prepare totals
    quoteData.totals = totalsData.totalSegments.map(segment => ({
      ...this.processPrice(segment, ['value'])
    }));

    // merge items data
    quoteData.items = quoteData.items.map(item => {
      const totalsDataItem = totalsData.items.find(totalDataItem => totalDataItem.itemId === item.itemId);
      const { extensionAttributes } = totalsDataItem;
      delete totalsDataItem.extensionAttributes;

      this.processPrice(totalsDataItem, [
        'price',
        'priceInclTax',
        'rowTotalInclTax',
        'rowTotalWithDiscount',
        'taxAmount',
        'discountAmount',
        'weeeTaxAmount'
      ]);

      extensionAttributes.availableQty = parseFloat(extensionAttributes.availableQty);

      item.link = this.convertPathToUrl(item.urlPath);

      if (totalsDataItem.options) {
        totalsDataItem.itemOptions =
          typeof totalsDataItem.options === 'string' ? JSON.parse(totalsDataItem.options) : totalsDataItem.options;
      }

      return { ...item, ...totalsDataItem, ...extensionAttributes };
    });

    return quoteData;
  }

  /**
   * Fetch country list
   * @returns {CountryList} parsed country list
   */
  async countryList() {
    const countries = await this.getAuth(
      '/directory/countries',
      {},
      {
        cacheOptions: { ttl: 86400 }, // 24 hours cache
        context: {
          isAuthRequired: false,
          didReceiveResult: result =>
            result.map(item => ({
              id: item.id,
              code: item.two_letter_abbreviation,
              englishName: item.full_name_english,
              localName: item.full_name_locale,
              regions: item.available_regions || []
            }))
        }
      }
    );

    return { items: countries };
  }

  /**
   * Make request for customer token
   * @param {object} obj Parent object
   * @param {SignIn} input form data
   * @param {string} input.email user email
   * @param {string} input.password user password
   * @returns {Promise<boolean>} true if login was successful
   */
  async signIn(obj, { input }) {
    const { cart: { quoteId } = { quoteId: undefined } } = this.session;
    const dateNow = Date.now();

    try {
      const token = await this.post('/integration/customer/token', {
        username: input.email,
        password: input.password
      });

      // todo: validTime should be extracted from the response, but after recent changes Magento doesn't send it
      // so that should be changed once https://github.com/deity-io/falcon-magento2-development/issues/32 is resolved
      const validTime = 1;

      // calculate token expiration date and subtract 1 minute for margin
      const tokenValidationTimeInMinutes = validTime * 60 - 1;
      const tokenExpirationTime = addMinutes(dateNow, tokenValidationTimeInMinutes);
      this.logger.debug(`Customer token valid for ${validTime} hours, till ${tokenExpirationTime.toString()}`);

      this.session.customerToken = {
        token,
        expirationTime: tokenExpirationTime.getTime()
      };

      this.removeCartData();

      // if guest has the cart then merge it with customer's cart
      if (quoteId) {
        await this.mergeGuestCart(quoteId);
      } else {
        await this.ensureCart();
      }

      // true when user signed in correctly
      return true;
    } catch (e) {
      // todo: use new version of error handler
      // wrong password or login is not an internal error.
      if (e.statusCode === 401) {
        // todo: this is how old version of the extension worked - it needs to be adapted to the new way of error handling
        e.userMessage = true;
        e.noLogging = true;
      }
      throw e;
    }
  }

  /**
   * Log out customer.
   * @todo revoke customer token using Magento api
   * @returns {Promise<boolean>} true
   */
  async signOut() {
    /* Remove logged in customer data */
    delete this.session.customerToken;
    this.removeCartData();

    return true;
  }

  /**
   * Create customer account
   * @param {object} obj Parent object
   * @param {SignUp} input registration form data
   * @param {string} input.email customer email
   * @param {string} input.firstname customer first name
   * @param {string} input.lastname customer last name
   * @param {string} input.password customer password
   * @returns {Promise<Customer>} - new customer data
   */
  async signUp(obj, { input }) {
    const { email, firstname, lastname, password, autoSignIn } = input;
    const customerData = {
      customer: {
        email,
        firstname,
        lastname
      },
      password
    };

    try {
      await this.postAuth('/customers', customerData);

      if (autoSignIn) {
        return this.signIn(obj, { input: { email, password } });
      }

      return true;
    } catch (e) {
      // todo: use new version of error handler

      // code 400 is returned if password validation fails or given email is already registered
      if (e.statusCode === 400) {
        e.userMessage = true;
        e.noLogging = true;
      }
      throw e;
    }
  }

  /**
   * Fetch customer data
   * @returns {Promise<Customer>} - converted customer data
   */
  async customer() {
    if (!this.isCustomerLoggedIn()) {
      // returning null cause that it is easier to check on client side if User is authenticated
      // in other cases we should throw AuthenticationError()
      return null;
    }

    const response = await this.getForCustomer('/customers/me');

    const convertedData = this.convertKeys(response);
    convertedData.addresses = convertedData.addresses.map(addr => this.convertAddressData(addr));

    const { extensionAttributes = {} } = convertedData;
    if (!isEmpty(extensionAttributes)) {
      delete convertedData.extensionAttributes;
    }

    return { ...convertedData, ...extensionAttributes };
  }

  /**
   * Converts address response from magento to Address type
   * @param {object} response api response
   * @returns {Address} parsed address
   */
  convertAddressData(response) {
    response = this.convertKeys(response);

    if (!has(response, 'defaultBilling')) {
      response.defaultBilling = false;
    }

    if (!has(response, 'defaultShipping')) {
      response.defaultShipping = false;
    }

    return response;
  }

  /**
   * Fetch customers order list
   * @param {object} obj Parent object
   * @param {object} params request params
   * @param {object} params.query request query params
   * @param {number} params.query.page pagination page
   * @param {number} params.query.perPage number of items per page
   * @returns {OrderList} parsed orders with pagination info
   */
  async orderList(obj, params) {
    const { pagination = { perPage: this.perPage, page: 1 } } = params;
    const searchCriteria = this.createSearchCriteria({
      pagination,
      sort: { field: 'created_at', direction: 'desc' }
    });
    const response = await this.getForCustomer('/falcon/orders/mine', { searchCriteria }, { context: { pagination } });

    return {
      ...response,
      items: response.items.map(x => this.reduceOrder(x))
    };
  }

  /**
   * Fetch info about customer order based on order id
   * @param {object} obj Parent object
   * @param {{id: number}} params request params
   * @returns {Promise<Order>} - order info
   */
  async order(obj, params) {
    const { id } = params;

    if (!id) {
      this.logger.error(`Trying to fetch customer order info without order id`);
      throw new Error('Failed to load an order.');
    }

    const response = await this.getForCustomer(`/falcon/orders/${id}/order-info`);
    return this.reduceOrder(response);
  }

  /**
   * Process customer order data
   * @param {object} response response from Magento2 backend
   * @returns {Order} processed order
   */
  reduceOrder(response) {
    const order = this.convertKeys(response);
    const { extensionAttributes = {}, payment = {}, entityId, incrementId, items, ...orderRest } = order;

    const result = {
      ...orderRest,
      id: entityId,
      referenceNo: incrementId,
      items: this.convertItemsResponse(items),
      shippingAddress: extensionAttributes.shippingAddress,
      paymentMethodName: payment.extensionAttributes ? payment.extensionAttributes.methodName : payment.method
    };

    return result;
  }

  /**
   * Update magento items collection response
   * @param {Array<object>} response products bought
   * @returns {OrderItem[]} converted items
   */
  convertItemsResponse(response = []) {
    const products = response.filter(item => item.productType === 'simple');

    return products.map(item => {
      // If product is configurable ask for parent_item price otherwise price is equal to 0
      const product = item.parentItem || item;
      const { urlPath, options, extensionAttributes } = product;

      const result = {
        ...product,
        itemOptions: options ? JSON.parse(options) : [],
        qty: product.qtyOrdered,
        rowTotalInclTax: product.basePriceInclTax,
        link: this.convertPathToUrl(urlPath),
        thumbnailUrl: extensionAttributes ? extensionAttributes.thumbnailUrl : undefined
      };

      return result;
    });
  }

  /**
   * Update items in cart
   * @param {object} obj Parent object
   * @param {UpdateCartItemInput} input cart item data
   * @param {string} input.sku item sku
   * @param {number} input.qty item qty
   * @param {number} input.itemId item id
   * @returns {Promise<CartItemPayload>} updated item data
   */
  async updateCartItem(obj, { input }) {
    const { cart } = this.session;
    const { quoteId } = cart;
    const { itemId, sku, qty } = input;

    const cartPath = this.getCartPath();

    if (!quoteId) {
      throw new Error('Trying to update cart item without quoteId');
    }

    const data = {
      cartItem: {
        quote_id: quoteId,
        sku,
        qty: parseInt(qty, 10)
      }
    };

    const cartItem = await this.putAuth(`${cartPath}/items/${itemId}`, data);

    this.convertKeys(cartItem);
    this.processPrice(cartItem, ['price']);

    return cartItem;
  }

  /**
   * Remove item from cart
   * @param {object} obj Parent object
   * @param {RemoveCartItemInput} input cart item data
   * @param {string} input.itemId item id
   * @returns {Promise<RemoveCartItemResponse>} RemoveCartItemResponse with itemId when operation was successful
   */
  async removeCartItem(obj, { input }) {
    const { cart } = this.session;
    const { itemId } = input;
    const cartPath = this.getCartPath();

    if (cart && cart.quoteId) {
      const result = await this.deleteAuth(`${cartPath}/items/${itemId}`);
      if (result) {
        return {
          itemId
        };
      }
    } else {
      this.logger.warn(`Trying to remove cart item without quoteId`);
    }

    return {};
  }

  /**
   * Updates customer profile data
   * @param {object} obj Parent object
   * @param {CustomerInput} data data to be saved
   * @returns {Promise<Customer>} updated customer data
   */
  async editCustomer(obj, { input }) {
    const response = await this.putAuth('/customers/me', { customer: { ...input } });

    return this.convertKeys(response);
  }

  /**
   * Request customer address
   * @param {object} obj Parent object
   * @param {object} params request params
   * @param {number} params.id address id
   * @returns {Promise<Address>} requested address data
   */
  async address(obj, { id }) {
    const response = await this.getForCustomer(`/falcon/customers/me/address/${id}`);

    return this.convertAddressData(response);
  }

  /**
   * Get country details
   * @param {object} obj parent object
   * @param {ID} obj.countryId country ID
   * @returns {promise<Country>} requested country data
   */
  async country({ countryId }) {
    const countries = await this.countryList();
    return countries.items.find(country => country.id === countryId);
  }

  /**
   * Get region details
   * @param {object} obj parent object
   * @param {object} obj.region region object
   * @returns {promise<Country>} requested region data
   */
  async addressRegion({ region }) {
    if (!region || !region.region) {
      return null;
    }
    return {
      id: region.regionId,
      code: region.regionCode,
      name: region.region
    };
  }

  /**
   * Request customer addresses
   * @returns {Promise<AddressList>} requested addresses data
   */
  async addressList() {
    const response = await this.getForCustomer('/falcon/customers/me/address');
    const items = response.items || [];

    return { items: items.map(x => this.convertAddressData(x)) };
  }

  /**
   * Add new customer address
   * @param {object} obj Parent object
   * @param {AddressInput} data address data
   * @returns {Promise<Address>} added address data
   */
  async addAddress(obj, { input }) {
    const response = await this.postForCustomer('/falcon/customers/me/address', { address: { ...input } });

    return this.convertAddressData(response);
  }

  /**
   * Change customer address data
   * @param {object} obj Parent object
   * @param {AddressInput} data data to change
   * @returns {Promise<Address>} updated address data
   */
  async editAddress(obj, { input }) {
    const response = await this.putForCustomer(`/falcon/customers/me/address`, { address: { ...input } });

    return this.convertAddressData(response);
  }

  /**
   * Remove customer address data
   * @param {object} obj Parent object
   * @param {object} params request params
   * @param {number} params.id address id
   * @returns {boolean} true when removed successfully
   */
  async removeAddress(obj, { id }) {
    return this.deleteForCustomer(`/falcon/customers/me/address/${id}`);
  }

  /**
   * Check if given password reset token is valid
   * @param {object} obj Parent object
   * @param {object} params request params
   * @param {string} params.token reset password token
   * @returns {Promise<boolean>} true if token is valid
   */
  async validatePasswordToken(obj, params) {
    const { token } = params;

    try {
      // TODO: we need to get customer ID by its email and pass it instead of `0`
      return this.getForIntegration(`/customers/0/password/resetLinkToken/${token}`);
    } catch (e) {
      // TODO: use new version of error handler
      e.userMessage = true;
      e.noLogging = true;
      // TODO: check why there's no throw here
    }
  }

  /**
   * Generate customer password reset token
   * @param {object} obj Parent object
   * @param {EmailInput} input request params
   * @param {string} input.email user email
   * @returns {Promise<boolean>} always true to avoid spying for registered emails
   */
  async requestPasswordReset(obj, { input }) {
    const { email } = input;
    await this.putAuth('/customers/password', { email, template: 'email_reset' });
    return true;
  }

  /**
   * Reset customer password using provided reset token
   * @param {object} obj Parent object
   * @param {CustomerPasswordReset} input request params
   * @param {string} input.customerId customer email
   * @param {string} input.resetToken reset token
   * @param {string} input.password new password to set
   * @returns {Promise<boolean>} true on success
   */
  async resetPassword(obj, { input }) {
    const { resetToken, password: newPassword } = input;
    return this.putAuth('/falcon/customers/password/reset', { email: '', resetToken, newPassword });
  }

  /**
   * Change customer password
   * @param {object} obj Parent object
   * @param {CustomerPasswordReset} input request params
   * @param {string} input.password new password
   * @param {string} input.currentPassword current password
   * @returns {Promise<boolean>} true on success
   */
  async changePassword(obj, { input }) {
    const { password: newPassword, currentPassword } = input;

    try {
      return this.putForCustomer('/customers/me/password', { currentPassword, newPassword });
    } catch (e) {
      // todo: use new version of error handler
      if ([401, 503].includes(e.statusCode)) {
        e.userMessage = true;
        // avoid removing customer token in onError hook
        delete e.code;
        e.noLogging = true;
      }

      throw e;
    }
  }

  /**
   * Apply coupon to cart
   * @param {object} obj Parent object
   * @param {CouponInput} input request data
   * @param {string} [input.couponCode] coupon code
   * @returns {Promise<boolean>} true on success
   */
  async applyCoupon(obj, { input }) {
    const { cart } = this.session,
      route = this.getCartPath();

    if (!cart || !cart.quoteId) {
      throw new Error('Trying to apply coupon without quoteId in session');
    }

    try {
      return this.putAuth(`${route}/coupons/${input.couponCode}`);
    } catch (e) {
      if (e.statusCode === 404) {
        e.userMessage = true;
        e.noLogging = true;
      }

      throw e;
    }
  }

  /**
   * Remove coupon from the cart
   * @returns {Promise<boolean>} true on success
   */
  async cancelCoupon() {
    const { cart } = this.session;
    const route = this.getCartPath();

    if (cart && cart.quoteId) {
      return this.deleteAuth(`${route}/coupons`);
    }

    throw new Error('Trying to remove coupon without quoteId in session');
  }

  /**
   * Removes unnecessary fields from address entry and adds proper id so Magento doesn't crash
   * @param {AddressInput} address address to process
   * @returns {AddressInput} processed address
   */
  prepareAddressForOrder(address) {
    const data = { ...address };
    // if that's a saved addr it will have proper id - in this case we have to add customer_address_id field
    // as magento accepts that one (not plain "id")
    if (data.id) {
      data.customer_address_id = data.id;
      delete data.id;
    }
    delete data.defaultBilling;
    delete data.defaultShipping;
    return data;
  }

  /**
   * Make a call to cart related endpoint
   * @param {string} path path to magento api endpoint
   * @param {string} method request method
   * @param {object} data request data
   * @returns {Promise<object>} response data
   */
  async performCartAction(path, method, data?: any) {
    const { cart } = this.session;

    if (!cart.quoteId) {
      const errorMessage = `Quote id is empty, cannot perform api call for ${path}`;

      this.logger.warn(errorMessage);
      throw new Error(errorMessage);
    }

    const cartPath = this.getCartPath();
    const falconPrefix = FALCON_CART_ACTIONS.indexOf(path) === -1 ? '' : '/falcon';
    const response = await this[`${method}Auth`](`${falconPrefix}${cartPath}${path}`, method === 'get' ? null : data);

    const cartData = this.convertKeys(response);

    if (cartData instanceof Object) {
      return response;
    }

    return {
      data: cartData
    };
  }

  async setShippingAddress(root, { input: address }) {
    this.session.cart.shippingAddress = address;
    this.context.session.save();
    return true;
  }

  async setBillingAddress(root, { input: address }) {
    this.session.cart.billingAddress = address;
    this.context.session.save();
    return true;
  }

  async shippingMethodList() {
    if (!this.session.cart.shippingAddress) {
      return [];
    }

    const input = {
      address: this.prepareAddressForOrder(this.session.cart.shippingAddress)
    };

    const response = await this.performCartAction('/estimate-shipping-methods', 'post', input);
    response.forEach(method => {
      method.currency = this.session.currency;
    });

    return this.convertKeys(response);
  }

  async paymentMethodList() {
    const { billingAddress, shippingAddress, shippingCarrierCode, shippingMethodCode } = this.session.cart;
    const magentoData = {
      addressInformation: {
        shippingCarrierCode,
        shippingMethodCode,
        billingAddress: this.prepareAddressForOrder(billingAddress),
        shippingAddress: this.prepareAddressForOrder(shippingAddress)
      }
    };

    const { paymentMethods } = await this.performCartAction('/shipping-information', 'post', magentoData);
    return paymentMethods;
  }

  /**
   * Sets shipping method for the order
   * @param {object} obj Parent object
   * @param {SetShippingInput} input shipping configuration
   * @returns {Promise<ShippingInformation>} shipping configuration info
   */
  async setShippingMethod(obj, { input }) {
    const { billingAddress, shippingAddress } = this.session.cart;
    const {
      method: shippingMethodCode,
      data: { carrierCode: shippingCarrierCode }
    } = input;
    this.session.cart.shippingCarrierCode = shippingCarrierCode;
    this.session.cart.shippingMethodCode = shippingMethodCode;

    const magentoData = {
      addressInformation: {
        shippingCarrierCode,
        shippingMethodCode,
        billingAddress: this.prepareAddressForOrder(billingAddress),
        shippingAddress: this.prepareAddressForOrder(shippingAddress)
      }
    };

    await this.performCartAction('/shipping-information', 'post', magentoData);
    return true;
  }

  async setPaymentMethod() {
    // Will be handled on "placeOrder" mutation
    return true;
  }

  getPaymentMethodConfig(paymentMethod) {
    return paymentMethod.code in this.config.payments ? this.config.payments[paymentMethod.code] : {};
  }

  /**
   * Sets payment method for the current cart
   * @param {object} obj Root object
   * @param {PlaceOrderInput} input Payment info payload
   * @returns {object} Result
   */
  async setPaymentInfo(obj, { input }) {
    const address = this.prepareAddressForOrder(input.billingAddress);
    return this.performCartAction('/set-payment-information', 'post', {
      email: input.email,
      billingAddress: address,
      paymentMethod: {
        method: input.paymentMethod.method,
        additionalData: input.paymentMethod.additionalData
      }
    });
  }

  /**
   * Place order
   * @param {object} obj Parent object
   * @param {PlaceOrderInput} input form data
   * @param {object} context context
   * @param {object} info info
   * @returns {Promise<PlaceOrderResult>} order data
   */
  async placeOrder(obj, { input }, context, info) {
    const { paymentMethod: paymentData } = input;
    const { method: paymentMethod, data: additionalData } = paymentData;

    if (paymentMethod === 'paypal_express') {
      return this.handlePayPalToken(input);
    }

    const { orderId, orderRealId, extensionAttributes } = await this.performCartAction('/place-order', 'put', {
      ...input,
      paymentMethod: {
        method: paymentMethod,
        additionalData
      }
    });

    if (!orderId) {
      throw new Error('no order id from magento.');
    }

    this.session.orderId = orderId;
    this.session.orderQuoteId = this.session.cart.quoteId;

    if (extensionAttributes && extensionAttributes.adyenCc) {
      return this.handleAdyen3dSecure(extensionAttributes.adyenCc);
    }
    this.removeCartData();

    const order = {
      id: orderId,
      referenceNo: orderRealId
    };

    const orderFields = graphqlFragmentFields(info, 'Order');
    if (Object.keys(orderFields).length <= 2 && orderFields.id && orderFields.referenceNo) {
      return order;
    }

    return this.order(order, { id: order.id });
  }

  /**
   * Handling Adyen 3D-secure payment
   * @param {object} adyenCcResult adyenRedirect data
   * @returns {object} Redirect response data
   */
  handleAdyen3dSecure(adyenCcResult) {
    const { origin } = this.context.headers;
    const { issuerUrl, md, paRequest } = adyenCcResult;
    let { termUrl } = adyenCcResult;

    // `origin` is available on client-side request (checkout page)
    // replacing "magento host" with the one from the client-side request
    if (origin) {
      const originUrl = url.parse(origin);
      termUrl = url.format({
        protocol: originUrl.protocol,
        host: originUrl.host,
        pathname: url.parse(termUrl).pathname
      });
    }

    return {
      url: issuerUrl,
      method: 'POST',
      fields: [
        {
          name: 'PaReq',
          value: paRequest
        },
        {
          name: 'MD',
          value: md
        },
        {
          name: 'TermUrl',
          value: termUrl
        }
      ]
    };
  }

  /**
   * Handling PayPal payment on its own page
   * @param {object} input Order payload
   * @returns {object} PayPal response data
   */
  async handlePayPalToken(input) {
    const { origin } = this.context.headers;

    if (origin) {
      const paypalReturnSuccess = `${origin}${this.getPathWithPrefix(
        `/falcon${this.getCartPath()}/paypal-express-return`
      )}`;
      const paypalReturnCancel = `${origin}${this.getPathWithPrefix(
        `/falcon${this.getCartPath()}/paypal-express-cancel`
      )}`;

      input.paymentMethod.additionalData = Object.assign({}, input.paymentMethod.additionalData, {
        paypal_return_success: paypalReturnSuccess,
        paypal_return_cancel: paypalReturnCancel,
        redirect_failure: 'failure',
        redirect_cancel: 'cancel',
        redirect_success: 'success'
      });
    }

    const setPaymentInfoResult = await this.setPaymentInfo({}, { input });
    if (!setPaymentInfoResult) {
      throw new Error('Failed to set payment information');
    }
    const fetchTokenResult = await this.performCartAction('/paypal-express-fetch-token', 'get');

    return {
      url: fetchTokenResult.url,
      method: 'GET',
      fields: []
    };
  }

  /**
   * Load last customer's order
   * @returns {Promise<Order>} last order data
   */
  async lastOrder() {
    const { orderId } = this.session;

    if (!orderId) {
      this.logger.warn(`Trying to fetch order info without order id`);
      return {};
    }

    const response = this.isCustomerLoggedIn()
      ? await this.getForCustomer(`/falcon/orders/${orderId}/order-info`)
      : await this.getForIntegration(`/falcon/guest-orders/${orderId}/order-info`);

    return this.reduceOrder(response);
  }

  removeCartData() {
    delete this.session.cart;
    this.context.session.save();
  }

  /**
   * Fetches breadcrumbs for passed path
   * @param {object} obj parent
   * @param {object} params parameters passed to the resolver
   * @returns {Promise<[Breadcrumb]>} breadcrumbs fetched from backend
   */
  async breadcrumbs(obj, { path }) {
    const response = await this.getForIntegration(`/falcon/breadcrumbs`, { url: path.replace(/^\//, '') });
    return this.convertBreadcrumbs(this.convertKeys(response));
  }

  /**
   * Fetches subcategories of fetched category
   * @param {object} obj parent object
   * @returns {Promise<[Category]>} fetched subcategories
   */
  async categoryChildren(obj) {
    return new Promise((res, rej) => {
      Promise.all(obj.children.split(',').map(id => this.category(obj, { id }))).then(res, rej);
    });
  }

  /**
   * Convert raw aggregations from Magento to proper format
   * @param {[object]} rawAggregations raw aggregations data
   * @returns {[Aggregation]} - processed aggregations
   */
  processAggregations(rawAggregations = []) {
    return rawAggregations.map(item => ({
      field: item.code,
      type: undefined,
      buckets: item.options.map(option => ({
        count: option.count,
        value: option.value,
        title: stripHtml(option.label)
      })),
      title: item.label
    }));
  }
};
