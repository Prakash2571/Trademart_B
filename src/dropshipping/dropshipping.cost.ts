/**
 * Order economics: landed cost, commercial cost, contribution and margin.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE
 * ------------------------------------
 * An unknown cost is UNKNOWN, never zero. If nobody recorded what a product cost,
 * this module refuses to report a profit for that order - because a zero cost
 * produces a beautiful margin and a confident, wrong decision.
 *
 * That means totals propagate ignorance upward: an unknown supplier cost makes the
 * landed cost unknown, which makes the commercial cost unknown, which makes the
 * profit unknown. Each step records WHY in `missingInputs`, so the UI can say
 * "unknown because no supplier cost is recorded" instead of just "-".
 *
 * EXCLUDED IS NOT UNKNOWN
 * -----------------------
 * Turning off payment fees means they contribute a KNOWN zero, by policy. Not
 * knowing the payment fee means the total is unknown. Both would render as "0" in a
 * naive model and the difference decides whether a margin can be trusted.
 *
 * WHAT SHOPIFY DOES *NOT* TELL US
 * -------------------------------
 * Shopify reports `totalShippingPrice`: what the CUSTOMER PAID for shipping. That
 * is revenue, and it is NOT what the supplier charges to ship. Using it as supplier
 * shipping cost would be a category error that flatters every margin - so supplier
 * shipping comes only from recorded supplier data, and is UNKNOWN otherwise.
 *
 * Pure: no Shopify, no database, no config singleton, no clock.
 */

import {
  percentageOf,
  roundMoney,
  subtractMoney,
  sumMoney,
} from '../common/money';
import {
  DEFAULT_DROPSHIP_COST_CONFIG,
  type DataConfidence,
  type DropshipCostConfig,
  type Figure,
  type OrderEconomics,
} from './dropshipping.types';

/* ---------------------------------------------------------------- figures -- */

function known(amount: number, currencyCode: string | null, source: string): Figure {
  return { amount: roundMoney(amount), currencyCode, confidence: 'KNOWN', source };
}

function estimated(amount: number, currencyCode: string | null, source: string): Figure {
  return { amount: roundMoney(amount), currencyCode, confidence: 'ESTIMATED', source };
}

function unknown(source: string): Figure {
  // amount is null, never 0 - the invariant the whole module rests on.
  return { amount: null, currencyCode: null, confidence: 'UNKNOWN', source };
}

/** A component switched off by configuration: a KNOWN zero contribution. */
function excluded(currencyCode: string | null, label: string): Figure {
  return {
    amount: 0,
    currencyCode,
    confidence: 'KNOWN',
    source: `Excluded by configuration (${label}), so it contributes nothing.`,
  };
}

const CONFIDENCE_ORDER: Record<DataConfidence, number> = {
  KNOWN: 0,
  ESTIMATED: 1,
  UNKNOWN: 2,
};

/** The weakest confidence wins: a total is only as trustworthy as its worst input. */
export function worstConfidence(...values: DataConfidence[]): DataConfidence {
  let worst: DataConfidence = 'KNOWN';
  for (const value of values) {
    if (CONFIDENCE_ORDER[value] > CONFIDENCE_ORDER[worst]) worst = value;
  }
  return worst;
}

/**
 * Adds figures, propagating ignorance.
 *
 * Any UNKNOWN component makes the sum UNKNOWN. Summing only the known parts would
 * silently understate the total, which for a COST means overstating profit - the
 * most expensive direction to be wrong in.
 */
function addFigures(
  parts: readonly { figure: Figure; label: string }[],
  currencyCode: string | null,
  describe: (contributing: string[]) => string,
): { figure: Figure; missing: string[] } {
  const missing = parts
    .filter((part) => part.figure.confidence === 'UNKNOWN')
    .map((part) => part.label);

  if (missing.length > 0) {
    return {
      figure: unknown(
        `Cannot be totalled: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unknown. Summing only the known parts would understate the cost and overstate profit.`,
      ),
      missing,
    };
  }

  const amounts = parts.map((part) => part.figure.amount);
  const total = sumMoney(...amounts);
  const confidence = worstConfidence(...parts.map((part) => part.figure.confidence));
  const contributing = parts
    .filter((part) => (part.figure.amount ?? 0) !== 0)
    .map((part) => part.label);

  return {
    figure: {
      amount: total,
      currencyCode,
      confidence,
      source: describe(contributing),
    },
    missing: [],
  };
}

/* ------------------------------------------------------------------ input -- */

export interface CostLineInput {
  quantity: number;
  /**
   * Shopify's cost per item for the variant sold. Null when never filled in.
   * This is the per-unit PRODUCT cost only - it contains no shipping.
   */
  unitCost: number | null;
  /** Operator-recorded supplier shipping per unit. Null when not recorded. */
  unitShippingCost?: number | null;
  /** Operator-recorded per-unit fulfillment surcharge. Null when not recorded. */
  unitFulfillmentCost?: number | null;
  /** For naming the line in a warning. */
  title?: string;
}

export interface OrderCostInput {
  currencyCode: string | null;
  /** What the customer paid, from Shopify. Null when Shopify withheld it. */
  customerRevenue: number | null;
  lines: readonly CostLineInput[];
  config?: DropshipCostConfig;
}

/* ------------------------------------------------------------- per-line ---- */

/**
 * Totals one cost component across the order's lines.
 *
 * A single line with an unrecorded value makes the whole component unknown, and the
 * offending lines are named. Pricing an order from the three lines that HAVE costs
 * while ignoring the fourth is precisely the silent understatement this avoids.
 */
function totalPerUnit(
  lines: readonly CostLineInput[],
  pick: (line: CostLineInput) => number | null | undefined,
  currencyCode: string | null,
  label: string,
): { figure: Figure; missingLines: string[] } {
  if (lines.length === 0) {
    return { figure: unknown(`No line items, so ${label} cannot be determined.`), missingLines: [] };
  }

  const missingLines: string[] = [];
  const perLine: number[] = [];

  lines.forEach((line, index) => {
    const value = pick(line);
    if (value === null || value === undefined) {
      missingLines.push(line.title ?? `line ${index + 1}`);
      return;
    }
    // Quantity multiplies in minor units so a per-unit cost times a quantity is an
    // exact whole number of pence rather than a float that merely looks like money.
    perLine.push(roundMoney(value * line.quantity));
  });

  if (missingLines.length > 0) {
    return {
      figure: unknown(
        `${label} is not recorded for: ${missingLines.join(', ')}. The order total is therefore unknown rather than partial.`,
      ),
      missingLines,
    };
  }

  return {
    figure: known(
      sumMoney(...perLine),
      currencyCode,
      `Sum of recorded ${label} across ${lines.length} line item(s).`,
    ),
    missingLines,
  };
}

/* ------------------------------------------------------------ the model ---- */

/**
 * Computes one order's economics.
 *
 * Order of derivation, each step honest about what it does not know:
 *   1. revenue                (Shopify)
 *   2. supplier product cost  (Shopify cost per item x quantity)
 *   3. supplier shipping      (recorded supplier data ONLY - never customer-paid)
 *   4. landed cost            = 2 + 3 + fulfillment surcharge
 *   5. fees + allowance       (percentages of revenue, therefore ESTIMATED)
 *   6. commercial cost        = 4 + 5 + other
 *   7. contribution + margin  = 1 - 6
 */
export function computeOrderEconomics(input: OrderCostInput): OrderEconomics {
  const config = input.config ?? DEFAULT_DROPSHIP_COST_CONFIG;
  const currency = input.currencyCode;
  const warnings: string[] = [];
  const missingInputs: string[] = [];

  // ---- 1. revenue ---------------------------------------------------------
  const customerRevenue =
    input.customerRevenue === null
      ? unknown('Shopify did not report an order total.')
      : known(input.customerRevenue, currency, 'Order total, as charged by Shopify.');
  if (customerRevenue.confidence === 'UNKNOWN') missingInputs.push('customerRevenue');

  // ---- 2. supplier product cost -------------------------------------------
  const productCost = totalPerUnit(
    input.lines,
    (line) => line.unitCost,
    currency,
    'supplier product cost',
  );
  if (productCost.figure.confidence === 'UNKNOWN') {
    missingInputs.push('supplierProductCost');
    warnings.push(
      productCost.missingLines.length > 0
        ? `No supplier cost recorded for ${productCost.missingLines.join(', ')}. Profit for this order cannot be calculated - set "Cost per item" in Shopify or record a manual cost.`
        : 'No supplier cost is available for this order, so profit cannot be calculated.',
    );
  }

  // ---- 3. supplier shipping ----------------------------------------------
  //
  // NOT from Shopify's totalShippingPrice, which is what the CUSTOMER paid. That
  // is revenue; using it here would flatter every margin.
  let supplierShippingCost: Figure;
  if (!config.includeSupplierShipping) {
    supplierShippingCost = excluded(currency, 'supplier shipping not included');
  } else {
    const shipping = totalPerUnit(
      input.lines,
      (line) => line.unitShippingCost,
      currency,
      'supplier shipping cost',
    );
    supplierShippingCost = shipping.figure;
    if (shipping.figure.confidence === 'UNKNOWN') {
      missingInputs.push('supplierShippingCost');
      warnings.push(
        'Supplier shipping cost is not recorded, so it is UNKNOWN - not free. Any margin shown excluding it would be an upper bound.',
      );
    }
  }

  // ---- fulfillment surcharge (optional, usually absent) -------------------
  const anyFulfillmentRecorded = input.lines.some(
    (line) => line.unitFulfillmentCost !== null && line.unitFulfillmentCost !== undefined,
  );
  const supplierFulfillmentCost = anyFulfillmentRecorded
    ? totalPerUnit(
        input.lines,
        (line) => line.unitFulfillmentCost ?? 0,
        currency,
        'supplier fulfillment cost',
      ).figure
    : // Nothing recorded on ANY line: there is no surcharge for this supplier, which
      // is a known zero rather than a gap. Distinguished from the case where SOME
      // lines have one and others do not, which totalPerUnit reports as unknown.
      known(0, currency, 'No per-unit fulfillment surcharge is recorded for this supplier.');

  // ---- 4. landed cost -----------------------------------------------------
  const landed = addFigures(
    [
      { figure: productCost.figure, label: 'supplier product cost' },
      { figure: supplierShippingCost, label: 'supplier shipping' },
      { figure: supplierFulfillmentCost, label: 'fulfillment surcharge' },
    ],
    currency,
    (contributing) =>
      contributing.length === 0
        ? 'Landed cost is zero: no supplier costs apply to this order.'
        : `Landed cost = ${contributing.join(' + ')}. This is the money owed to the supplier.`,
  );

  // ---- 5. fees and allowance (percentages of revenue) --------------------
  const revenue = customerRevenue.amount;

  function feeOf(
    include: boolean,
    percentage: number,
    label: string,
    note: string,
  ): Figure {
    if (!include) return excluded(currency, `${label} not included`);
    if (revenue === null) {
      return unknown(`${label} is a percentage of revenue, and the order total is unknown.`);
    }
    // ESTIMATED, not KNOWN: this is a modelled rate, not the fee the processor
    // actually charged. Shopify's Admin API does not expose real per-order gateway
    // fees for every payment provider, and pretending otherwise would dress a
    // guess up as an observation.
    return estimated(percentageOf(revenue, percentage), currency, note);
  }

  const paymentFees = feeOf(
    config.includePaymentFees,
    config.paymentFeePercentage,
    'Payment fees',
    `Estimated at ${config.paymentFeePercentage}% of revenue. Not the processor's actual charge.`,
  );
  const shopifyFees = feeOf(
    config.includeShopifyFees,
    config.shopifyFeePercentage,
    'Platform fees',
    `Estimated at ${config.shopifyFeePercentage}% of revenue.`,
  );
  const advertisingAllowance = feeOf(
    config.includeAdvertisingAllowance,
    config.advertisingAllowancePercentage,
    'Advertising allowance',
    `An allowance of ${config.advertisingAllowancePercentage}% of revenue, not measured ad spend.`,
  );
  const otherCommercialCosts =
    config.otherCommercialCostPerOrder === 0
      ? known(0, currency, 'No flat per-order commercial cost is configured.')
      : known(
          config.otherCommercialCostPerOrder,
          currency,
          'Configured flat per-order commercial cost.',
        );

  for (const [figure, key] of [
    [paymentFees, 'paymentFees'],
    [shopifyFees, 'shopifyFees'],
    [advertisingAllowance, 'advertisingAllowance'],
  ] as const) {
    if (figure.confidence === 'UNKNOWN') missingInputs.push(key);
  }

  // ---- 6. commercial cost -------------------------------------------------
  const commercial = addFigures(
    [
      { figure: landed.figure, label: 'landed cost' },
      { figure: paymentFees, label: 'payment fees' },
      { figure: shopifyFees, label: 'platform fees' },
      { figure: advertisingAllowance, label: 'advertising allowance' },
      { figure: otherCommercialCosts, label: 'other commercial costs' },
    ],
    currency,
    (contributing) =>
      `Commercial cost = ${contributing.join(' + ')}. This is the basis of contribution, and is NOT what the supplier is owed.`,
  );

  // ---- 7. contribution and margin ----------------------------------------
  let estimatedProfit: Figure;
  let estimatedMargin: OrderEconomics['estimatedMargin'];

  if (revenue === null || commercial.figure.amount === null) {
    const reason =
      revenue === null
        ? 'the order total is unknown'
        : 'the commercial cost is unknown';
    estimatedProfit = unknown(
      `Contribution cannot be calculated because ${reason}. It is not zero, and it is not the revenue.`,
    );
    estimatedMargin = { value: null, confidence: 'UNKNOWN' };
  } else {
    const profit = subtractMoney(revenue, commercial.figure.amount);
    const confidence = worstConfidence(
      customerRevenue.confidence,
      commercial.figure.confidence,
    );
    estimatedProfit = {
      amount: profit,
      currencyCode: currency,
      confidence,
      source: 'Revenue minus commercial cost.',
    };
    estimatedMargin = {
      // Margin on REVENUE (contribution / revenue), the convention the pricing
      // engine already uses - not margin on cost, which would read much higher for
      // the same order.
      value: revenue === 0 ? null : roundMoney((profit / revenue) * 100, 'margin'),
      confidence,
    };
    if (profit < 0) {
      warnings.push(
        `This order loses money as costed: contribution is ${profit.toFixed(2)}. Check the supplier cost and the selling price.`,
      );
    }
  }

  const confidence = worstConfidence(
    customerRevenue.confidence,
    landed.figure.confidence,
    commercial.figure.confidence,
    estimatedProfit.confidence,
  );

  return {
    currencyCode: currency,
    customerRevenue,
    supplierProductCost: productCost.figure,
    supplierShippingCost,
    supplierFulfillmentCost,
    paymentFees,
    shopifyFees,
    advertisingAllowance,
    otherCommercialCosts,
    landedCost: landed.figure,
    commercialCost: commercial.figure,
    estimatedProfit,
    estimatedMargin,
    confidence,
    // Deduplicated: several components can be unknown for the same missing input.
    missingInputs: [...new Set(missingInputs)],
    warnings,
  };
}
