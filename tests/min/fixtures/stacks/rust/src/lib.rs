pub mod calc;

#[cfg(test)]
mod tests {
    use crate::calc::Calc;

    #[test]
    fn adds() {
        assert_eq!(Calc::add(2, 3), 5);
    }
}
