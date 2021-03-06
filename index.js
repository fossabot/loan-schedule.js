"use strict";
const Decimal = require("decimal.js");
const moment = require("moment");
const ProdCal = require("prod-cal");

module.exports = LoanSchedule;

let that = undefined;

function LoanSchedule(options) {
    that = this;
    this.decimal = 2;
    this.dateFormat = "DD.MM.YYYY";
    this.prodCalendar = undefined;

    if (options) {
        this.decimal = options.decimalDigit || this.decimal;
        this.dateFormat = options.dateFormat || this.dateFormat;
        this.prodCalendar = new ProdCal(options.prodCalendar) || this.prodCalendar;
    }
}

LoanSchedule.prototype.calculateSchedule = function (p) {
    let schedule = {};
    if (p.scheduleType === this.ANNUITY_SCHEDULE) {
        schedule.payments = this.calculateAnnuitySchedule(p);
    }
    if (p.scheduleType === this.DIFFERENTIATED_SCHEDULE) {
        schedule.payments = this.calculateDifferentiatedSchedule(p);
    }
    if (p.scheduleType === this.BUBBLE_SCHEDULE) {
        schedule.payments = this.calculateBubbleSchedule(p);
    }

    let paymentLastIndex = schedule.payments.length - 1;
    let firstPayment = schedule.payments[1].paymentAmount;
    let lastPayment = schedule.payments[paymentLastIndex].paymentAmount;
    schedule.minPaymentAmount = Decimal.min(firstPayment, lastPayment).toFixed(this.decimal);
    schedule.maxPaymentAmount = Decimal.max(firstPayment, lastPayment).toFixed(this.decimal);

    let dateStart = moment(schedule.payments[0].paymentDate, this.dateFormat).date(1);
    let dateEnd = moment(schedule.payments[paymentLastIndex].paymentDate, this.dateFormat).date(1);
    schedule.term = Math.round(moment.duration(dateEnd.diff(dateStart)).asMonths());

    schedule.amount = new Decimal(p.amount).toFixed(this.decimal);
    schedule.overAllInterest = new Decimal(0);
    schedule.payments.map(pay => {
        let overAllInterest = new Decimal(schedule.overAllInterest).plus(pay.interestAmount);
        schedule.overAllInterest = overAllInterest.toFixed(this.decimal);
    });

    schedule.efficientRate = new Decimal(schedule.overAllInterest).div(schedule.amount).mul(100).toFixed(this.decimal);
    schedule.fullAmount = new Decimal(schedule.overAllInterest).add(schedule.amount).toFixed(this.decimal);
    return schedule;
};

LoanSchedule.prototype.calculateAnnuitySchedule = function (p) {
    let date = moment(p.issueDate, this.dateFormat);
    let term = new Decimal(p.term);
    let amount = new Decimal(p.amount);
    let rate = new Decimal(p.rate);
    let interestAccruedAmount = new Decimal(0);
    let regularPaymentAmount = new Decimal(p.paymentAmount || this.calculateAnnuityPaymentAmount({amount: p.amount, term: p.term, rate: p.rate}));

    let payments = [this.getInitialPayment(amount, date, rate)];

    let schedulePoints = Array.apply(null, {length: term.toNumber() + 1}).map(Number.call, Number).map(i =>
        that.getSchedulePoint(
            (i === 0) ? date.clone() : date.clone().add(i, "months").date(p.paymentOnDay),
            this.ER_TYPE_REGULAR,
            regularPaymentAmount
        )
    ).concat(Object.keys(p.earlyRepayment || new Object({}))
        .map(d => that.getSchedulePoint(moment(d, this.dateFormat), p.earlyRepayment[d].erType, new Decimal(p.earlyRepayment[d].erAmount))))
        .sort((a, b) =>
            a.paymentDate.isSame(b, "day") ? 0 : (a.paymentDate.isAfter(b.paymentDate) ? 1 : -1)
        );


    let i = 1;
    while (i < schedulePoints.length && new Decimal(payments[i - 1].finalBalance).gt(0)) {
        let pay = {};

        pay.paymentDate = schedulePoints[i].paymentDate.format(this.dateFormat);
        pay.initialBalance = payments[i - 1].finalBalance;
        pay.interestRate = rate.toFixed(this.decimal);
        pay.annuityPaymentAmount = this.calculateAnnuityPaymentAmount({amount: pay.initialBalance, term: term.toNumber() - i + 1, rate: pay.interestRate});
        let paymentAmount = schedulePoints[i].paymentAmount;

        interestAccruedAmount = interestAccruedAmount.plus(
            this.calculateInterestByPeriod({
                from: payments[i - 1].paymentDate,
                to: pay.paymentDate,
                amount: pay.initialBalance,
                rate: pay.interestRate
            })
        );

        if (schedulePoints[i].paymentType === this.ER_TYPE_REGULAR) {
            if ((i !== schedulePoints.length - 1) && paymentAmount.lt(pay.initialBalance)) {
                if (interestAccruedAmount.gt(paymentAmount)) {
                    pay.interestAmount = paymentAmount.toFixed(this.decimal);
                    interestAccruedAmount = interestAccruedAmount.minus(paymentAmount);
                } else {
                    pay.interestAmount = interestAccruedAmount.toFixed(this.decimal);
                    interestAccruedAmount = Decimal(0);
                }
                pay.principalAmount = paymentAmount.minus(new Decimal(pay.interestAmount)).toFixed(this.decimal);
                pay.paymentAmount = paymentAmount.toFixed(this.decimal);
            } else {
                pay.interestAmount = interestAccruedAmount.toFixed(this.decimal);
                pay.principalAmount = pay.initialBalance;
                pay.paymentAmount = new Decimal(pay.principalAmount).plus(new Decimal(pay.interestAmount)).toFixed(this.decimal);
            }
        } else {
            pay.principalAmount = paymentAmount.toFixed(this.decimal);
            pay.paymentAmount = paymentAmount.toFixed(this.decimal);
            pay.interestAmount = new Decimal(0).toFixed(this.decimal);
        }

        pay.finalBalance = new Decimal(pay.initialBalance).minus(new Decimal(pay.principalAmount));

        payments.push(pay);
        i++;
    }


    return payments;

};

LoanSchedule.prototype.calculateDifferentiatedSchedule = function (p) {
    let date = moment(p.issueDate, this.dateFormat);
    let term = new Decimal(p.term);
    let amount = new Decimal(p.amount);
    let rate = new Decimal(p.rate);
    let principalAmount = amount.div(term);

    let payments = [this.getInitialPayment(amount, date, rate)];
    let i = 1;
    while (i <= term.toNumber()) {
        let pay = {};

        date = date.add(1, "months").date(p.paymentOnDay);
        pay.paymentDate = date.format(this.dateFormat);
        pay.initialBalance = payments[i - 1].finalBalance;
        pay.interestRate = rate.toFixed(this.decimal);
        pay.principalAmount = i === term.toNumber() ? pay.initialBalance : principalAmount.toFixed(this.decimal);
        pay.interestAmount = new Decimal(
            this.calculateInterestByPeriod({
                from: payments[i - 1].paymentDate,
                to: pay.paymentDate,
                amount: pay.initialBalance,
                rate: pay.interestRate
            })
        ).toFixed(this.decimal);
        pay.paymentAmount = new Decimal(pay.principalAmount).plus(new Decimal(pay.interestAmount)).toFixed(this.decimal);
        pay.finalBalance = new Decimal(pay.initialBalance).minus(new Decimal(pay.principalAmount)).toFixed(this.decimal);

        payments.push(pay);
        i++;
    }
    return payments;

};

LoanSchedule.prototype.calculateBubbleSchedule = function (p) {
    let date = moment(p.issueDate, this.dateFormat);
    let term = new Decimal(p.term);
    let amount = new Decimal(p.amount);
    let rate = new Decimal(p.rate);

    let payments = [this.getInitialPayment(amount, date, rate)];
    let i = 1;
    while (i <= term.toNumber()) {
        let pay = {};

        date = date.add(1, "months").date(p.paymentOnDay);
        pay.paymentDate = date.format(this.dateFormat);
        pay.initialBalance = payments[i - 1].finalBalance;
        pay.interestRate = rate.toFixed(this.decimal);
        pay.principalAmount = i === term.toNumber() ? pay.initialBalance : new Decimal(0).toFixed(this.decimal);
        pay.interestAmount = new Decimal(
            this.calculateInterestByPeriod({
                from: payments[i - 1].paymentDate,
                to: pay.paymentDate,
                amount: pay.initialBalance,
                rate: pay.interestRate
            })
        ).toFixed(this.decimal);
        pay.paymentAmount = new Decimal(pay.principalAmount).plus(new Decimal(pay.interestAmount)).toFixed(this.decimal);
        pay.finalBalance = new Decimal(pay.initialBalance).minus(new Decimal(pay.principalAmount)).toFixed(this.decimal);

        payments.push(pay);
        i++;
    }
    return payments;

};

LoanSchedule.prototype.calculateMaxLoanAmount = function (p) {
    let term = new Decimal(p.term);
    let interestRate = new Decimal(p.rate).div(100).div(12);
    let paymentAmount = new Decimal(p.paymentAmount);
    let amount = paymentAmount.div(interestRate.div(interestRate.plus(1).pow(term.neg()).neg().plus(1)));
    return amount.toFixed(this.decimal);
};

LoanSchedule.prototype.calculateAnnuityPaymentAmount = function (p) {
    let term = new Decimal(p.term);
    let interestRate = new Decimal(p.rate).div(100).div(12);
    let paymentAmount = new Decimal(p.amount).mul(interestRate.div(interestRate.plus(1).pow(term.neg()).neg().plus(1)));
    return paymentAmount.toFixed(this.decimal);
};

LoanSchedule.prototype.calculateInterestByPeriod = function (p) {
    let curIntr = new Decimal(0);
    let dateFrom = moment(p.from, this.dateFormat);
    let dateTo = moment(p.to, this.dateFormat);
    if (dateFrom.isSame(dateTo, "year")) {
        curIntr = curIntr.plus(getInterestByPeriod({from: dateFrom, to: dateTo, amount: p.amount, rate: p.rate}));
    } else {
        let endOfYear = moment({years: dateFrom.year(), months: 11, days: 31});
        curIntr = curIntr.plus(getInterestByPeriod({from: dateFrom, to: endOfYear, amount: p.amount, rate: p.rate}));
        curIntr = curIntr.plus(getInterestByPeriod({from: endOfYear, to: dateTo, amount: p.amount, rate: p.rate}));
    }
    return curIntr.toFixed(this.decimal);
};

LoanSchedule.prototype.getInitialPayment = function (amount, date, rate) {
    return {
        paymentDate: date.format(this.dateFormat),
        initialBalance: new Decimal(0).toFixed(this.decimal),
        paymentAmount: new Decimal(0).toFixed(this.decimal),
        annuityPaymentAmount: new Decimal(0).toFixed(this.decimal),
        interestAmount: new Decimal(0).toFixed(this.decimal),
        principalAmount: new Decimal(0).toFixed(this.decimal),
        finalBalance: new Decimal(amount).toFixed(this.decimal),
        interestRate: rate.toFixed(this.decimal)
    };
};

LoanSchedule.prototype.ANNUITY_SCHEDULE = "ANNUITY";
LoanSchedule.prototype.DIFFERENTIATED_SCHEDULE = "DIFFERENTIATED";
LoanSchedule.prototype.BUBBLE_SCHEDULE = "BUBBLE";
LoanSchedule.prototype.ER_TYPE_MATURITY = "ER_MATURITY";
LoanSchedule.prototype.ER_TYPE_ANNUITY = "ER_ANNUITY";
LoanSchedule.prototype.ER_TYPE_REGULAR = "REGULAR";

function getInterestByPeriod(p) {
    return new Decimal(p.rate).div(100).div(p.to.year() % 4 === 0 ? 366 : 365).mul(moment.duration(p.to.diff(p.from)).asDays()).mul(p.amount);
}

LoanSchedule.prototype.isHoliday = function (date) {
    return that.prodCalendar !== undefined && that.prodCalendar.getDay(parseInt(date.format("YYYY")), parseInt(date.format("MM")), parseInt(date.format("DD"))) === ProdCal.prototype.DAY_HOLIDAY;
};

LoanSchedule.prototype.getSchedulePoint = function (paymentDate, paymentType, paymentAmount) {
    let calcPaymentDate = paymentDate.clone();
    while (that.isHoliday(calcPaymentDate)) calcPaymentDate.add(1, "days");
    return new Object({
        "paymentDate": calcPaymentDate,
        "paymentType": paymentType,
        "paymentAmount": paymentAmount,
    });
};

