output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "앱(ECS)이 들어가는 서브넷"
  value       = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  description = "DB 서브넷. 인터넷 경로가 없다"
  value       = aws_subnet.isolated[*].id
}
