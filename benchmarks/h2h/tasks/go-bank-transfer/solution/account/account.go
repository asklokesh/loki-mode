// Package account models a single customer account. Amounts are in cents.
package account

import "errors"

// ErrNonPositive is returned when an amount is zero or negative.
var ErrNonPositive = errors.New("amount must be positive")

// ErrOverdraft is returned when a withdrawal would go past the overdraft limit.
var ErrOverdraft = errors.New("overdraft limit exceeded")

// Entry is one line of an account's history.
type Entry struct {
	Kind         string // "deposit", "withdrawal", "transfer-out" or "transfer-in"
	Amount       int64  // signed: positive credits the account, negative debits it
	Memo         string
	BalanceAfter int64
	Counterparty string // the other account's id for transfers, empty otherwise
}

// Account is a customer account. Balance may go negative down to
// -OverdraftLimit.
type Account struct {
	ID             string
	Owner          string
	Balance        int64
	OverdraftLimit int64
	History        []Entry
}

// New returns an account with an opening balance and an empty history.
func New(id, owner string, balance int64) *Account {
	return &Account{ID: id, Owner: owner, Balance: balance}
}

// CanDebit reports whether cents can leave the account without going past
// the overdraft limit.
func (a *Account) CanDebit(cents int64) bool {
	return a.Balance-cents >= -a.OverdraftLimit
}

// Deposit adds cents to the balance and records a "deposit" entry.
func (a *Account) Deposit(cents int64, memo string) error {
	if cents <= 0 {
		return ErrNonPositive
	}
	a.Balance += cents
	a.History = append(a.History, Entry{Kind: "deposit", Amount: cents, Memo: memo, BalanceAfter: a.Balance})
	return nil
}

// Withdraw removes cents from the balance and records a "withdrawal" entry.
// The balance may not drop below -OverdraftLimit.
func (a *Account) Withdraw(cents int64, memo string) error {
	if cents <= 0 {
		return ErrNonPositive
	}
	if !a.CanDebit(cents) {
		return ErrOverdraft
	}
	a.Balance -= cents
	a.History = append(a.History, Entry{Kind: "withdrawal", Amount: -cents, Memo: memo, BalanceAfter: a.Balance})
	return nil
}

// TransferOut debits cents and records a "transfer-out" entry naming to.
// The caller has already checked CanDebit.
func (a *Account) TransferOut(cents int64, to, memo string) {
	a.Balance -= cents
	a.History = append(a.History, Entry{Kind: "transfer-out", Amount: -cents, Memo: memo, BalanceAfter: a.Balance, Counterparty: to})
}

// TransferIn credits cents and records a "transfer-in" entry naming from.
func (a *Account) TransferIn(cents int64, from, memo string) {
	a.Balance += cents
	a.History = append(a.History, Entry{Kind: "transfer-in", Amount: cents, Memo: memo, BalanceAfter: a.Balance, Counterparty: from})
}
