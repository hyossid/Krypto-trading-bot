/// <reference path="../common/models.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />
/// <reference path="broker.ts" />
/// <reference path="../common/messaging.ts" />
///<reference path="persister.ts"/>

import util = require("util");
import Config = require("./config");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Broker = require("./broker");
import Messaging = require("../common/messaging");
import moment = require('moment');
import _ = require("lodash");
import Persister = require("./persister");

export class SafetyCalculator {
    NewValue = new Utils.Evt();

    private _log = Utils.log("safety");

    private _latest: Models.TradeSafety = null;
    public get latest() { return this._latest; }
    public set latest(val: Models.TradeSafety) {
        if (!this._latest || Math.abs(val.combined - this._latest.combined) > 1e-3) {
            this._latest = val;
            this.NewValue.trigger(this.latest);

            this._persister.persist(this.latest);
            this._publisher.publish(this.latest);
        }
    }

    private _buys: Models.Trade[] = [];
    private _sells: Models.Trade[] = [];

    constructor(
        private _timeProvider: Utils.ITimeProvider,
        private _repo: Interfaces.IRepository<Models.QuotingParameters>,
        private _broker: Broker.OrderBroker,
        private _qlParams: Interfaces.IRepository<Models.QuotingParameters>,
        private _publisher: Messaging.IPublish<Models.TradeSafety>,
        private _persister: Persister.IPersist<Models.TradeSafety>) {
        _publisher.registerSnapshot(() => [this.latest]);
        _repo.NewParameters.on(_ => this.computeQtyLimit());
        _qlParams.NewParameters.on(_ => this.computeQtyLimit());
        _broker.Trade.on(this.onTrade);

        _timeProvider.setInterval(this.computeQtyLimit, moment.duration(1, "seconds"));
    }

    private onTrade = (ut: Models.Trade) => {
        var u = _.cloneDeep(ut);
        if (this.isOlderThan(u, this._repo.latest)) return;

        if (u.side === Models.Side.Ask) {
            this._sells.push(u);
        }
        else if (u.side === Models.Side.Bid) {
            this._buys.push(u);
        }

        this.computeQtyLimit();
    };

    private isOlderThan(o: Models.Trade, settings: Models.QuotingParameters) {
        var now = this._timeProvider.utcNow();
        return Math.abs(Utils.fastDiff(now, o.time)) > (1000 * settings.tradeRateSeconds);
    }

    private computeQtyLimit = () => {
        var settings = this._repo.latest;

        var buyS = 0;
        var sellS = 0;
        var buySq = 0;
        var sellSq = 0;
        this._log.info("!! Calc", this._broker._trades.length);
        for (var ti = this._broker._trades.length - 1; ti > -1; ti--) {
          this._log.info("!! Side", this._broker._trades[ti].side == Models.Side.Bid);
          this._log.info("!! time", this._broker._trades[ti].time);
          this._log.info("!! Price", this._broker._trades[ti].price);
          this._log.info("!! Quantity", this._broker._trades[ti].quantity);
          if (buySq>settings.size && sellSq>settings.size) break;
          if (this._broker._trades[ti].side == Models.Side.Bid && buySq<=settings.size) {
            buyS += this._broker._trades[ti].price;
            buySq += this._broker._trades[ti].quantity;
          }
          if (this._broker._trades[ti].side == Models.Side.Ask && sellSq<=settings.size) {
            sellS += this._broker._trades[ti].price;
            sellSq += this._broker._trades[ti].quantity;
          }
          this._log.info("!! buyS", buyS);
          this._log.info("!! buySq", buySq);
          this._log.info("!! sellS", sellS);
          this._log.info("!! sellSq", sellSq);
        }

        if (buySq) buyS /= buySq;
        if (sellSq) sellS /= sellSq;
        this._log.info("!! buyS", buyS);
        this._log.info("!! buySq", buySq);
        this._log.info("!! sellS", sellS);
        this._log.info("!! sellSq", sellSq);

        var orderTrades = (input: Models.Trade[], direction: number): Models.Trade[]=> {
            return _.chain(input)
                .filter(o => !this.isOlderThan(o, settings))
                .sortBy((t: Models.Trade) => direction * t.price)
                .value();
        };

        this._buys = orderTrades(this._buys, -1);
        this._sells = orderTrades(this._sells, 1);

        // don't count good trades against safety
        while (_.size(this._buys) > 0 && _.size(this._sells) > 0) {
            var sell = _.last(this._sells);
            var buy = _.last(this._buys);
            if (sell.price >= buy.price) {

                var sellQty = sell.quantity;
                var buyQty = buy.quantity;

                buy.quantity -= sellQty;
                sell.quantity -= buyQty;

                if (buy.quantity < 1e-4) this._buys.pop();
                if (sell.quantity < 1e-4) this._sells.pop();
            }
            else {
                break;
            }
        }

        var computeSafety = (t: Models.Trade[]) => t.reduce((sum, t) => sum + t.quantity, 0) / this._qlParams.latest.size;

        this.latest = new Models.TradeSafety(computeSafety(this._buys) || 0, computeSafety(this._sells) || 0,
            buyS, sellS, computeSafety(this._buys.concat(this._sells)) || 0, this._timeProvider.utcNow());
    };
}