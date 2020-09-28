import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { partition } from 'lodash';

import { expenseStatus } from '../../../constants';
import EXPENSE_TYPE from '../../../constants/expense_type';
import queries from '../../../lib/queries';
import models, { Op, sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { ExpenseCollection } from '../collection/ExpenseCollection';
import ExpenseStatusFilter from '../enum/ExpenseStatusFilter';
import { ExpenseType } from '../enum/ExpenseType';
import PayoutMethodType from '../enum/PayoutMethodType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';
import ISODateTime from '../scalar/ISODateTime';

const updateFilterConditionsForReadyToPay = async (where, include): Promise<void> => {
  where['status'] = expenseStatus.APPROVED;

  // Get all collectives matching the search that have APPROVED expenses
  const results = await models.Expense.findAll({
    where,
    include,
    attributes: ['FromCollectiveId', 'CollectiveId'],
    group: ['Expense.FromCollectiveId', 'Expense.CollectiveId'],
    raw: true,
  });

  const [expensesSubjectToTaxForm, expensesWithoutTaxForm] = partition(e => e.type !== EXPENSE_TYPE.RECEIPT);

  const taxFormConditions = { [Op.and]: [] };
  if (expensesSubjectToTaxForm.length > 0) {
    // Check the balances for these collectives. The following will emit an SQL like:
    // AND ((CollectiveId = 1 AND amount < 5000) OR (CollectiveId = 2 AND amount < 3000))
    const balances = await queries.getBalances(results.map(e => e.CollectiveId));
    taxFormConditions[Op.and].push({
      [Op.or]: balances.map(({ CollectiveId, balance }) => ({
        CollectiveId,
        amount: { [Op.lte]: balance },
      })),
    });

    // Check tax forms
    const taxFormResults = await queries.getTaxFormsRequiredForAccounts(results.map(e => e.FromCollectiveId));
    taxFormResults.forEach(({ collectiveId }) => {
      taxFormConditions[Op.and].push({ FromCollectiveId: { [Op.not]: collectiveId } });
    });
  }

  if (taxFormConditions[Op.and].length) {
    if (expensesWithoutTaxForm.length) {
      const ignoredIds = expensesWithoutTaxForm.map(e => e.id);
      where[Op.and].push({ [Op.or]: [taxFormConditions, { id: { [Op.in]: ignoredIds } }] });
    } else {
      where[Op.and].push(taxFormConditions);
    }
  }
};

const ExpensesQuery = {
  type: ExpenseCollection,
  args: {
    ...CollectionArgs,
    fromAccount: {
      type: AccountReferenceInput,
      description: 'Reference of the account that submitted this expense',
    },
    account: {
      type: AccountReferenceInput,
      description: 'Reference of the account where this expense was submitted',
    },
    host: {
      type: AccountReferenceInput,
      description: 'Return expenses only for this host',
    },
    status: {
      type: ExpenseStatusFilter,
      description: 'Use this field to filter expenses on their statuses',
    },
    type: {
      type: ExpenseType,
      description: 'Use this field to filter expenses on their type (RECEIPT/INVOICE)',
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Only expenses that match these tags',
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
    minAmount: {
      type: GraphQLInt,
      description: 'Only return expenses where the amount is greater than or equal to this value (in cents)',
    },
    maxAmount: {
      type: GraphQLInt,
      description: 'Only return expenses where the amount is lower than or equal to this value (in cents)',
    },
    payoutMethodType: {
      type: PayoutMethodType,
      description: 'Only return expenses that use the given type as payout method',
    },
    dateFrom: {
      type: ISODateTime,
      description: 'Only return expenses that were created after this date',
    },
    searchTerm: {
      type: GraphQLString,
      description: 'The term to search',
    },
  },
  async resolve(_, args, req): Promise<CollectionReturnType> {
    const where = { [Op.and]: [] };
    const include = [];

    // Check arguments
    if (args.limit > 100) {
      throw new Error('Cannot fetch more than 100 expenses at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, account, host] = await Promise.all(
      [args.fromAccount, args.account, args.host].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );

    if (fromAccount) {
      where['FromCollectiveId'] = fromAccount.id;
    }
    if (account) {
      where['CollectiveId'] = account.id;
    }
    if (host) {
      include.push({
        association: 'collective',
        attributes: [],
        required: true,
        where: { HostCollectiveId: host.id },
      });
    }

    // Add search filter
    if (args.searchTerm) {
      const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
      const ilikeQuery = `%${sanitizedTerm}%`;
      where[Op.or] = [
        { description: { [Op.iLike]: ilikeQuery } },
        { tags: { [Op.overlap]: [args.searchTerm.toLowerCase()] } },
        { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
        { '$User.collective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$User.collective.name$': { [Op.iLike]: ilikeQuery } },
        // { '$items.description$': { [Op.iLike]: ilikeQuery } },
      ];

      include.push(
        { association: 'fromCollective', attributes: [] },
        { association: 'User', attributes: [], include: [{ association: 'collective', attributes: [] }] },
        // One-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
        // { association: 'items', duplicating: false, attributes: [], separate: true },
      );

      if (!isNaN(args.searchTerm)) {
        where[Op.or].push({ id: args.searchTerm });
      }
    }

    // Add filters
    if (args.type) {
      where['type'] = args.type;
    }
    if (args.tags) {
      where['tags'] = { [Op.contains]: args.tags };
    }
    if (args.minAmount) {
      where['amount'] = { [Op.gte]: args.minAmount };
    }
    if (args.maxAmount) {
      where['amount'] = { ...where['amount'], [Op.lte]: args.maxAmount };
    }
    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.payoutMethodType) {
      include.push({
        association: 'PayoutMethod',
        attributes: [],
        required: args.payoutMethodType !== PayoutMethodTypes.OTHER,
        where: { type: args.payoutMethodType },
      });

      if (args.payoutMethodType === PayoutMethodTypes.OTHER) {
        where[Op.and].push(sequelize.literal(`("PayoutMethodId" IS NULL OR "PayoutMethod".type = 'OTHER')`));
      }
    }

    if (args.status) {
      if (args.status !== 'READY_TO_PAY') {
        where['status'] = args.status;
      } else {
        await updateFilterConditionsForReadyToPay(where, include);
      }
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Expense.findAndCountAll({ include, where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ExpensesQuery;
