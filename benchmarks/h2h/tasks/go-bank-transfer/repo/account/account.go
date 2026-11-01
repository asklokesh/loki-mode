// Package account models a single customer account. Amounts are in cents.
package account

import "errors"

// ErrNonPositive is returned when an amount is zero or negative.
var ErrNonPositive = errors.New("amount must be positive")

// ErrOverdraft is returned when a withdrawal would go past the overdraft limit.
var ErrOverdraft = errors.New("overdraft limit exceeded")

// Entry is one line of an account's history.
type Entry struct {
	Kind         string // "deposit" or "withdrawal"
	Amount       int64  // signed: positive credits the account, negative debits it
	Memo         string
	BalanceAfter int64
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
	if a.Balance-cents < -a.OverdraftLimit {
		return ErrOverdraft
	}
	a.Balance -= cents
	a.History = append(a.History, Entry{Kind: "withdrawal", Amount: -cents, Memo: memo, BalanceAfter: a.Balance})
	return nil
}
