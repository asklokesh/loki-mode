// Package ledger keeps the bank's accounts, keyed by account id.
package ledger

import (
	"errors"
	"sort"

	"example.com/bank/account"
)

// ErrDuplicateAccount is returned by Open when the id is already taken.
var ErrDuplicateAccount = errors.New("ledger: duplicate account")

// Transfer errors.
var (
	ErrInvalidAmount     = errors.New("ledger: invalid amount")
	ErrSameAccount       = errors.New("ledger: cannot transfer to the same account")
	ErrUnknownAccount    = errors.New("ledger: unknown account")
	ErrInsufficientFunds = errors.New("ledger: insufficient funds")
)

// Ledger holds accounts by id.
type Ledger struct {
	accounts map[string]*account.Account
}

// New returns an empty ledger.
func New() *Ledger {
	return &Ledger{accounts: map[string]*account.Account{}}
}

// Open adds an account to the ledger.
func (l *Ledger) Open(a *account.Account) error {
	if _, ok := l.accounts[a.ID]; ok {
		return ErrDuplicateAccount
	}
	l.accounts[a.ID] = a
	return nil
}

// Get returns the account with the given id.
func (l *Ledger) Get(id string) (*account.Account, bool) {
	a, ok := l.accounts[id]
	return a, ok
}

// IDs returns every account id in ascending order.
func (l *Ledger) IDs() []string {
	ids := make([]string, 0, len(l.accounts))
	for id := range l.accounts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Total returns the sum of all balances.
func (l *Ledger) Total() int64 {
	var sum int64
	for _, a := range l.accounts {
		sum += a.Balance
	}
	return sum
}

// Transfer moves cents from one account to another. It changes nothing when
// it returns an error.
func (l *Ledger) Transfer(from, to string, cents int64, memo string) error {
	if cents <= 0 {
		return ErrInvalidAmount
	}
	if from == to {
		return ErrSameAccount
	}
	src, ok := l.accounts[from]
	if !ok {
		return ErrUnknownAccount
	}
	dst, ok := l.accounts[to]
	if !ok {
		return ErrUnknownAccount
	}
	if !src.CanDebit(cents) {
		return ErrInsufficientFunds
	}
	src.TransferOut(cents, to, memo)
	dst.TransferIn(cents, from, memo)
	return nil
}
